// SCIC 소식 저장소. 주소에 ?demo 가 있으면 이 기기 안에만 저장하는 체험 모드로 돕니다.
// 읽기는 누구나, 쓰기는 편집자로 등록된 구글 계정으로 로그인한 사람만 합니다.
// 편집자 명단은 meta/editors 문서({admins, editors})에 있고, 규칙이 로그인한 이메일을 이 명단과 맞춰 봅니다.
// 2026-09-30 Firebase 프로젝트를 지우고 체험판으로 돌립니다. 다시 연결하려면 새 프로젝트의 웹 설정값을 넣으세요.
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

export const isDemo = new URLSearchParams(location.search).has("demo") || !firebaseConfig.projectId;

export const DEFAULT_GROUPS = Array.from({ length: 13 }, (_, i) => `제${i + 1}선교그룹`);

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
const denied = () => Object.assign(new Error("denied"), { code: "permission-denied" });
const cleanList = (xs) => [...new Set((xs || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];

const store = isDemo ? demoStore() : await firebaseStore(firebaseConfig);
export default store;

/* ───────────── 체험 모드 ───────────── */
function demoStore() {
  const KEY = "scic.demo.v2";
  const empty = () => ({ articles: [], photos: [], issues: {}, settings: { groups: DEFAULT_GROUPS } });
  let db;
  try { db = JSON.parse(ls.get(KEY)) || null; } catch { db = null; }
  if (!db) { db = empty(); seed(db); }
  db.editors ||= { admins: ["demo@example.com"], editors: [] };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  save();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const subs = new Set();
  let user = ls.get("scic.demo.user") ? { email: "demo@example.com", name: "체험 편집자", photo: "" } : null;
  const emit = () => subs.forEach((fn) => fn(user));
  const roleOf = (email) => db.editors.admins.includes(email) ? "admin" : db.editors.editors.includes(email) ? "editor" : "";
  const check = () => { if (!user || !roleOf(user.email)) throw denied(); };

  return {
    demo: true,
    onAuth(fn) { subs.add(fn); fn(user); return () => subs.delete(fn); },
    async signIn() { ls.set("scic.demo.user", "1"); user = { email: "demo@example.com", name: "체험 편집자", photo: "" }; emit(); },
    async signOut() { ls.set("scic.demo.user", null); user = null; emit(); },
    async role() { return user ? roleOf(user.email) : ""; },
    async editors() { check(); return clone(db.editors); },
    async saveEditors(v) { check(); if (roleOf(user.email) !== "admin") throw denied(); db.editors = { admins: cleanList(v.admins), editors: cleanList(v.editors) }; save(); },
    async settings() { return clone(db.settings); },
    async saveSettings(s) { check(); db.settings = { ...db.settings, ...s }; save(); },
    async issues() { return clone(Object.entries(db.issues).map(([id, v]) => ({ ...v, id })).sort((a, b) => b.id.localeCompare(a.id))); },
    async issue(id) { return db.issues[id] ? clone({ ...db.issues[id], id }) : null; },
    async saveIssue(id, data) { check(); db.issues[id] = { ...(db.issues[id] || {}), ...data }; save(); },
    async articlesWhere(field, value) { return clone(db.articles.filter((a) => a[field] === value && a.status !== "deleted")); },
    async article(id) { const a = db.articles.find((x) => x.id === id); return a ? clone(a) : null; },
    newArticleId: newId,
    async saveArticle(id, data) {
      check();
      const i = db.articles.findIndex((x) => x.id === id);
      const now = Date.now();
      if (i < 0) db.articles.push({ ...data, id, createdAt: now, updatedAt: now });
      else db.articles[i] = { ...db.articles[i], ...data, updatedAt: now };
      save();
    },
    async photos(articleId) {
      return clone(db.photos.filter((p) => p.article === articleId && !p.hidden).sort((a, b) => a.order - b.order));
    },
    async addPhoto(p) {
      check();
      const id = newId();
      db.photos.push({ ...p, id, hidden: false, createdAt: Date.now() });
      try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* 체험 모드는 기기 저장 공간이 작아 사진이 새로고침 뒤 사라질 수 있어요 */ }
      return id;
    },
    async updatePhoto(id, data) {
      check();
      const p = db.photos.find((x) => x.id === id);
      if (p) Object.assign(p, data, data.hidden ? { data: "", thumb: "" } : {});
      save();
    },
    reset() { ls.set(KEY, null); },
  };
}

/* ───────────── Firebase ───────────── */
async function firebaseStore(config) {
  const base = "https://www.gstatic.com/firebasejs/10.14.1";
  const [{ initializeApp }, fs, au] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-auth.js`),
  ]);
  const app = initializeApp(config);
  const db = fs.getFirestore(app);
  const auth = au.getAuth(app);
  const ms = (t) => (t && t.toMillis ? t.toMillis() : typeof t === "number" ? t : Date.now());
  const toItem = (d) => { const v = d.data(); return { ...v, id: d.id, createdAt: ms(v.createdAt), updatedAt: ms(v.updatedAt) }; };
  const toUser = (u) => u && { email: (u.email || "").toLowerCase(), name: u.displayName || "", photo: u.photoURL || "" };
  const editorsRef = fs.doc(db, "meta", "editors");

  return {
    demo: false,
    onAuth(fn) { return au.onAuthStateChanged(auth, (u) => fn(toUser(u))); },
    async signIn() {
      const p = new au.GoogleAuthProvider();
      p.setCustomParameters({ prompt: "select_account" });
      try { await au.signInWithPopup(auth, p); }
      catch (e) {
        if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") return au.signInWithRedirect(auth, p);
        throw e;
      }
    },
    signOut() { return au.signOut(auth); },
    // 명단을 읽을 수 있으면 편집자다. 명단에 없는데 읽혔다면 규칙에 적힌 처음 관리자다.
    async role() {
      const u = toUser(auth.currentUser);
      if (!u) return "";
      try {
        const d = await fs.getDoc(editorsRef);
        const v = d.exists() ? d.data() : {};
        if ((v.editors || []).includes(u.email) && !(v.admins || []).includes(u.email)) return "editor";
        return "admin";
      } catch (e) {
        if (e.code === "permission-denied") return "";
        throw e;
      }
    },
    async editors() {
      const d = await fs.getDoc(editorsRef);
      const v = d.exists() ? d.data() : {};
      return { admins: v.admins || [], editors: v.editors || [] };
    },
    saveEditors(v) {
      return fs.setDoc(editorsRef, { admins: cleanList(v.admins), editors: cleanList(v.editors), updatedAt: fs.serverTimestamp() });
    },
    async settings() {
      const d = await fs.getDoc(fs.doc(db, "meta", "settings"));
      return d.exists() ? d.data() : { groups: DEFAULT_GROUPS };
    },
    saveSettings(s) {
      return fs.setDoc(fs.doc(db, "meta", "settings"), s, { merge: true });
    },
    async issues() {
      const s = await fs.getDocs(fs.collection(db, "issues"));
      return s.docs.map(toItem).sort((a, b) => b.id.localeCompare(a.id));
    },
    async issue(id) {
      const d = await fs.getDoc(fs.doc(db, "issues", id));
      return d.exists() ? toItem(d) : null;
    },
    saveIssue(id, data) {
      return fs.setDoc(fs.doc(db, "issues", id), { ...data, updatedAt: fs.serverTimestamp() }, { merge: true });
    },
    async articlesWhere(field, value) {
      const s = await fs.getDocs(fs.query(fs.collection(db, "articles"), fs.where(field, "==", value), fs.limit(400)));
      return s.docs.map(toItem).filter((a) => a.status !== "deleted");
    },
    async article(id) {
      const d = await fs.getDoc(fs.doc(db, "articles", id));
      return d.exists() ? toItem(d) : null;
    },
    newArticleId: () => fs.doc(fs.collection(db, "articles")).id,
    async saveArticle(id, data) {
      const ref = fs.doc(db, "articles", id);
      const exists = (await fs.getDoc(ref)).exists();
      return fs.setDoc(ref, {
        ...data, updatedAt: fs.serverTimestamp(),
        ...(exists ? {} : { createdAt: fs.serverTimestamp() }),
      }, { merge: true });
    },
    async photos(articleId) {
      const s = await fs.getDocs(fs.query(fs.collection(db, "photos"), fs.where("article", "==", articleId), fs.limit(200)));
      return s.docs.map(toItem).filter((p) => !p.hidden).sort((a, b) => a.order - b.order);
    },
    async addPhoto(p) {
      const ref = fs.doc(fs.collection(db, "photos"));
      await fs.setDoc(ref, { ...p, hidden: false, createdAt: fs.serverTimestamp() });
      return ref.id;
    },
    updatePhoto(id, data) {
      return fs.updateDoc(fs.doc(db, "photos", id), { ...data, ...(data.hidden ? { data: "", thumb: "" } : {}) });
    },
  };
}

/* ───────────── 체험용 예시 소식 ───────────── */
function scene(a, b, c, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/><circle cx="640" cy="130" r="70" fill="#fff" opacity=".55"/><path d="M0 470 Q200 380 400 450 T800 420 V600 H0Z" fill="${c}" opacity=".55"/><path d="M0 520 Q260 460 520 520 T800 500 V600 H0Z" fill="#fff" opacity=".35"/><g fill="#fff" opacity=".9"><circle cx="250" cy="395" r="22"/><rect x="232" y="420" width="36" height="60" rx="16"/><circle cx="330" cy="385" r="22"/><rect x="312" y="410" width="36" height="70" rx="16"/><circle cx="410" cy="398" r="20"/><rect x="394" y="420" width="32" height="58" rx="14"/></g><text x="40" y="70" font-family="sans-serif" font-size="30" fill="#fff" opacity=".9">${label}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function seed(db) {
  const P = [
    ["#f7c6d3", "#c9d2f5", "#e98aa5", "예시 사진"],
    ["#cfe3f7", "#e6d7f5", "#8fa6e0", "예시 사진"],
    ["#fde2c8", "#f7c6d3", "#e9a07a", "예시 사진"],
    ["#d7f0e3", "#cfe3f7", "#7fbf9f", "예시 사진"],
  ];
  const t0 = Date.parse("2026-09-01");
  const mk = (i, o) => {
    const id = "demo" + i;
    const pal = P[i % P.length];
    const photos = [0, 1, 2].slice(0, o.n ?? 2).map((k) => {
      const q = P[(i + k) % P.length];
      const src = scene(q[0], q[1], q[2], q[3]);
      db.photos.push({ id: id + "p" + k, article: id, data: src, thumb: src, caption: o.caps?.[k] || "", w: 800, h: 600, order: k, hidden: false });
      return src;
    });
    db.articles.push({
      id, status: "published", featured: false, videos: [], interviews: [], author: "SCIC 소식지 편집팀",
      createdAt: t0 + i * 3600e3, updatedAt: t0 + i * 3600e3,
      coverThumb: photos[0] || scene(...pal), photoCount: photos.length, ...o,
    });
  };

  mk(1, {
    issue: "2026-09", section: "event", featured: true,
    title: "일터에서 만난 하나님, 가을 연합 수련회",
    lead: "13개 선교 그룹 동문 180명이 한자리에 모였습니다.",
    who: "SCIC 동문 180명과 13개 선교 그룹 섬김이", when: "2026년 9월 12일(토) 오전 10시~오후 5시", where: "사랑의교회 안성수양관",
    what: "가을 연합 수련회를 열었습니다", how: "주제 강의, 그룹별 나눔, 일터 간증, 파송 기도 순서로 진행했습니다",
    why: "흩어져 일하는 동문들이 일터 선교의 부르심을 다시 확인하고 서로를 격려하기 위해서였습니다",
    body: "2026년 9월 12일(토) 오전 10시~오후 5시, SCIC 동문 180명과 13개 선교 그룹 섬김이가 사랑의교회 안성수양관에서 가을 연합 수련회를 열었습니다.\n\n흩어져 일하는 동문들이 일터 선교의 부르심을 다시 확인하고 서로를 격려하기 위해서였습니다. 주제 강의, 그룹별 나눔, 일터 간증, 파송 기도 순서로 진행했습니다.\n\n오후 간증 시간에는 세 분의 동문이 월요일 아침의 사무실, 공장, 병원에서 만난 하나님을 나눴습니다. 마지막 파송 기도에서는 선교 그룹마다 서로의 일터를 위해 손을 얹고 기도했습니다.",
    caps: ["주제 강의 시간", "그룹별 나눔", "파송 기도"], n: 3,
    interviews: [{ name: "김OO 동문", role: "12기 · 제조업", qa: [
      { q: "이번 수련회에서 가장 마음에 남은 순간은요?", a: "다른 기수 동문들과 같은 고민을 나눈 시간이요. 혼자가 아니라는 걸 알았습니다." },
      { q: "일터로 돌아가며 다짐한 것이 있다면요?", a: "매주 월요일 아침, 동료 한 사람을 위해 기도하기로 했습니다." },
    ] }],
  });
  mk(2, {
    issue: "2026-09", section: "event",
    title: "추석 맞이 이웃 나눔 바자회",
    lead: "모인 수익금 전액을 지역 복지관에 전했습니다.",
    who: "SCIC 동문회", when: "2026년 9월 20일(주일) 오후 1시", where: "사랑의교회 국제제자훈련원 로비",
    what: "추석 맞이 이웃 나눔 바자회를 열었습니다", how: "동문들이 직접 만든 반찬과 기증 물품을 팔았습니다",
    why: "명절을 홀로 보내는 이웃에게 기쁨을 나누기 위해서였습니다",
    body: "2026년 9월 20일(주일) 오후 1시, SCIC 동문회가 사랑의교회 국제제자훈련원 로비에서 추석 맞이 이웃 나눔 바자회를 열었습니다.\n\n명절을 홀로 보내는 이웃에게 기쁨을 나누기 위해서였습니다. 동문들이 직접 만든 반찬과 기증 물품을 팔았습니다.",
    caps: ["바자회 준비", "나눔 물품"],
  });
  mk(3, {
    issue: "2026-09", section: "group", group: "제3선교그룹",
    title: "새벽 6시, 출근 전 말씀 묵상 모임 1주년",
    lead: "매주 화요일 온라인으로 모여 온 1년을 돌아봤습니다.",
    who: "제3선교그룹 회원 14명", when: "2026년 9월 8일(화) 오전 6시", where: "온라인(줌)",
    what: "말씀 묵상 모임 1주년 감사 모임을 가졌습니다", how: "지난 1년 묵상 노트를 나누고 감사 제목을 적었습니다",
    why: "출근 전 말씀으로 하루를 여는 습관을 함께 지켜 온 것을 감사하기 위해서였습니다",
    body: "2026년 9월 8일(화) 오전 6시, 제3선교그룹 회원 14명이 온라인(줌)에서 말씀 묵상 모임 1주년 감사 모임을 가졌습니다.",
    caps: ["온라인 묵상 모임"], n: 1,
  });
  mk(4, {
    issue: "2026-09", section: "group", group: "제7선교그룹",
    title: "베트남 일터 선교사 화상 간담회",
    lead: "현지에서 사업체를 운영하는 동문 선교사와 만났습니다.",
    who: "제7선교그룹 회원과 베트남 호찌민의 동문 선교사 가정", when: "2026년 9월 17일(목) 저녁 8시", where: "온라인",
    what: "일터 선교사 화상 간담회를 열었습니다", how: "현지 사업과 직원 돌봄 이야기를 듣고 기도 제목을 받았습니다",
    why: "해외 일터 선교 현장을 알고 꾸준히 기도로 동역하기 위해서였습니다",
    body: "", caps: ["화상 간담회"], n: 2,
  });
  mk(5, {
    issue: "2026-09", section: "group", group: "제11선교그룹",
    title: "새내기 동문 환영 식사",
    lead: "", who: "제11선교그룹", when: "2026년 9월 26일(토) 낮 12시", where: "서초동 식당",
    what: "새로 수료한 동문을 환영하는 식사 모임을 가졌습니다", how: "", why: "",
    body: "", n: 1,
  });
  mk(6, {
    issue: "2026-08", section: "event", featured: true,
    title: "여름 일터 선교 특강: 월요일의 영성",
    lead: "무더위에도 120명이 함께했습니다.",
    who: "SCIC 동문과 가족 120명", when: "2026년 8월 22일(토) 오후 2시", where: "사랑의교회 본당",
    what: "여름 일터 선교 특강을 들었습니다", how: "특강 뒤 질의응답과 기수별 교제가 이어졌습니다",
    why: "일상 속 일터에서 신앙을 살아내는 길을 배우기 위해서였습니다",
    body: "2026년 8월 22일(토) 오후 2시, SCIC 동문과 가족 120명이 사랑의교회 본당에서 여름 일터 선교 특강을 들었습니다.",
    n: 2,
  });
  mk(7, {
    issue: "2026-08", section: "group", group: "제3선교그룹",
    title: "무료 진로 상담 봉사",
    lead: "", who: "제3선교그룹 회원 6명", when: "2026년 8월 9일(토)", where: "지역 청소년센터",
    what: "청소년 진로 상담 봉사를 했습니다", how: "직업별로 짝을 지어 1:1 상담을 했습니다", why: "다음 세대에게 일의 의미를 전하기 위해서였습니다",
    body: "", n: 1,
  });

  const byIssue = {};
  for (const a of db.articles) (byIssue[a.issue] ||= []).push(a);
  for (const [id, list] of Object.entries(byIssue)) db.issues[id] = summarize(list);
  db.issues["2026-09"].intro = "가을이 깊어 갑니다. 이번 달에는 연합 수련회와 바자회, 그리고 각 선교 그룹의 소식을 담았습니다. 일터에서 만난 은혜를 함께 나눠 주셔서 고맙습니다.";
  db.issues["2026-09"].headline = "일터에서 만난 하나님";
}

// 한 달 치 소식에서 보관함에 보일 요약을 만듭니다.
export function summarize(list) {
  const pub = list.filter((a) => a.status === "published");
  const sorted = [...pub].sort((a, b) => (b.featured - a.featured) || (a.section === "event" ? -1 : 1) - (b.section === "event" ? -1 : 1) || a.createdAt - b.createdAt);
  return {
    count: pub.length,
    events: pub.filter((a) => a.section === "event").length,
    groups: pub.filter((a) => a.section === "group").length,
    titles: sorted.slice(0, 4).map((a) => a.title),
    coverThumb: sorted.find((a) => a.coverThumb)?.coverThumb || "",
  };
}
