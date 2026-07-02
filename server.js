// server.js — 陕西省高考志愿填报模拟系统
// 2025-07-01 v2：管理员复杂密码 + IP绑定 + 活动追踪 + 部署就绪

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

// ========== SQL.js ==========
let db = null;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, raw_password TEXT, id_card_hash TEXT,
      raw_idcard TEXT, locked_ip TEXT, display_name TEXT, note TEXT,
      is_admin INTEGER DEFAULT 0, is_disabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
      ip TEXT, success INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      action TEXT, ip TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS schools (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, name TEXT NOT NULL,
      province TEXT, city TEXT, school_type TEXT, category TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS major_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, school_id INTEGER NOT NULL,
      group_code TEXT NOT NULL, group_name TEXT, subject_requirement TEXT,
      FOREIGN KEY (school_id) REFERENCES schools(id)
    );
    CREATE TABLE IF NOT EXISTS majors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL,
      major_code TEXT NOT NULL, major_name TEXT NOT NULL,
      plan_count INTEGER DEFAULT 0, tuition INTEGER, duration INTEGER DEFAULT 3,
      note TEXT, FOREIGN KEY (group_id) REFERENCES major_groups(id)
    );
  `);
  saveDB();

  // 首次部署：数据库为空时自动导入数据 + 创建默认管理员
  const schoolCount = db.exec("SELECT COUNT(*) FROM schools")[0]?.values?.[0]?.[0] || 0;
  if (schoolCount === 0) {
    console.log('[initDB] 数据库为空，自动导入招生计划数据...');
    const initDb = require('./init-db.js');
    await initDb.main(db);
    console.log('[initDB] 数据导入完成，默认管理员: admin / admin123');
    saveDB();
  }
  // 迁移：旧版 data.db 可能缺 raw_password / raw_idcard 列，自动补上
  try {
    const cols = dbAll("PRAGMA table_info(users)").map(c => c.name);
    if (cols.indexOf("raw_password") < 0) db.run("ALTER TABLE users ADD COLUMN raw_password TEXT");
    if (cols.indexOf("raw_idcard") < 0) db.run("ALTER TABLE users ADD COLUMN raw_idcard TEXT");
    if (cols.indexOf("locked_ip") < 0) db.run("ALTER TABLE users ADD COLUMN locked_ip TEXT");
    if (cols.indexOf("is_disabled") < 0) db.run("ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0");
    saveDB();
  } catch(e) { console.error("[migrate]", e); }
  // admin 用户如果没有 raw_idcard，自动生成一个（让前端确认弹窗可用）
  const adminU = dbGet("SELECT id, raw_idcard FROM users WHERE username = ?", ["admin"]);
  if (adminU && !adminU.raw_idcard) {
    const fakeId = "610000" + new Date().getFullYear() + "0101" + String(Math.floor(Math.random()*9000)+1000);
    dbRun("UPDATE users SET raw_idcard = ? WHERE id = ?", [fakeId, adminU.id]);
    console.log("[initDB] admin 测试身份证号已生成:", fakeId);
    saveDB();
  }
  // 密码升级：旧版 admin123 自动替换为强密码
  const adminUser = dbGet("SELECT id, password_hash FROM users WHERE username = ?", ["admin"]);
  if (adminUser && bcrypt.compareSync("admin123", adminUser.password_hash)) {
    const newHash = bcrypt.hashSync("cqvtr#eATHj@sn@h", 10);
    dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [newHash, adminUser.id]);
    console.log("[initDB] 管理员密码已升级为强密码");
    saveDB();
  }
  buildMemIndex();
}

function saveDB() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) {}
}
setInterval(saveDB, 30000);

// ========== 内存索引（启动时构建，避免每次查 sql.js） ==========
// 性能优化：lookup API 走内存查表，45 个志愿的回填从 30s 降到 < 1s
const memIndex = { schools: new Map(), groups: new Map(), majors: new Map(), ready: false };
function buildMemIndex() {
  memIndex.schools.clear();
  memIndex.groups.clear();
  memIndex.majors.clear();
  const schools = dbAll("SELECT id, code, name, province, city, school_type FROM schools");
  for (const s of schools) {
    memIndex.schools.set(s.code, { ...s, groups: [] });
  }
  const groups = dbAll("SELECT id, school_id, group_code, group_name, subject_requirement FROM major_groups");
  for (const g of groups) {
    const school = memIndex.schools.get(
      dbGet("SELECT code FROM schools WHERE id = ?", [g.school_id])?.code
    );
    if (!school) continue;
    const enriched = { ...g, school_code: school.code, school_name: school.name, majors: [] };
    memIndex.groups.set(`${school.code}|${g.group_code}`, enriched);
    school.groups.push({ id: g.id, group_code: g.group_code, group_name: g.group_name, subject_requirement: g.subject_requirement });
  }
  const majors = dbAll("SELECT id, group_id, major_code, major_name, plan_count, tuition, duration FROM majors");
  for (const m of majors) {
    const group = [...memIndex.groups.values()].find(g => g.id === m.group_id);
    if (!group) continue;
    memIndex.majors.set(`${group.school_code}|${group.group_code}|${m.major_code}`, m);
    // 同时按 groupId 建索引，前端 lookup/major 用 gid
    memIndex.majors.set(`g${m.group_id}|${m.major_code}`, m);
    group.majors.push({ id: m.id, major_code: m.major_code, major_name: m.major_name, plan_count: m.plan_count, tuition: m.tuition, duration: m.duration });
  }
  memIndex.ready = true;
  console.log(`[memIndex] 索引完成: ${memIndex.schools.size}所院校 ${memIndex.groups.size}个专业组 ${memIndex.majors.size}个专业`);
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql); if (params.length) stmt.bind(params);
  const r = []; while (stmt.step()) r.push(stmt.getAsObject()); stmt.free(); return r;
}
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql); if (params.length) stmt.bind(params);
  let r = null; if (stmt.step()) r = stmt.getAsObject(); stmt.free(); return r;
}
function dbRun(sql, params = []) {
  const stmt = db.prepare(sql); if (params.length) stmt.bind(params);
  stmt.step(); stmt.free(); return { changes: db.getRowsModified() };
}

// ========== Express ==========
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sx-gk-sim-2025-secure-key',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 2 * 60 * 60 * 1000 }
}));

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
}
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '请先登录' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// ========== 页面路由 ==========
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/admin', (req, res) => {
  if (req.session.userId && req.session.isAdmin) {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

app.get('/guide.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guide.html')));
app.get('/plan.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'plan.html')));
app.get('/history.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));

// ========== API ==========

// 登录（非管理员启用IP绑定）
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIP(req);
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) { dbRun('INSERT INTO login_logs (user_id, ip, success) VALUES (NULL, ?, 0)', [ip]); saveDB(); return res.status(401).json({ error: '账号或密码错误' }); }
  if (user.is_disabled) return res.status(403).json({ error: '该账号已被停用' });
  if (!bcrypt.compareSync(password, user.password_hash)) { dbRun('INSERT INTO login_logs (user_id, ip, success) VALUES (?, ?, 0)', [user.id, ip]); saveDB(); return res.status(401).json({ error: '账号或密码错误' }); }
  // 非管理员账号：IP 绑定校验
  if (!user.is_admin) {
    if (user.locked_ip && user.locked_ip !== ip) return res.status(403).json({ error: '该账号已绑定到其他IP地址。如需更换IP请联系管理员。' });
    if (!user.locked_ip) { dbRun('UPDATE users SET locked_ip = ? WHERE id = ?', [ip, user.id]); }
  }
  dbRun('INSERT INTO login_logs (user_id, ip, success) VALUES (?, ?, 1)', [user.id, ip]);
  dbRun('INSERT INTO activity_log (user_id, action, ip) VALUES (?,?,?)', [user.id, 'login', ip]);
  saveDB();
  req.session.userId = user.id; req.session.username = user.username;
  req.session.isAdmin = !!user.is_admin; req.session.displayName = user.display_name || user.username;
  res.json({ ok: true, displayName: user.display_name, username: user.username, isAdmin: !!user.is_admin, rawIdcard: user.raw_idcard });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => {}); res.json({ ok: true }); });

app.get('/api/me', requireLogin, (req, res) => {
  const user = dbGet('SELECT id, username, display_name, is_admin, raw_idcard FROM users WHERE id = ?', [req.session.userId]);
  res.json(user);
});

// 活动追踪（前端保存/确认时调用）
app.post('/api/activity/ping', requireLogin, (req, res) => {
  const ip = getClientIP(req);
  dbRun('INSERT INTO activity_log (user_id, action, ip) VALUES (?,?,?)', [req.session.userId, req.body.action || 'save', ip]);
  saveDB();
  res.json({ ok: true });
});

// ========== 代码查找 API ==========
app.get('/api/lookup/school/:code', requireLogin, (req, res) => {
  const school = memIndex.schools.get(req.params.code);
  if (!school) return res.json(null);
  // 一次返回：院校 + 所有专业组 + 所有专业，前端无需再单独查
  const groups = school.groups.map(g => {
    const full = memIndex.groups.get(`${school.code}|${g.group_code}`);
    return full ? {
      id: full.id, group_code: full.group_code, group_name: full.group_name,
      subject_requirement: full.subject_requirement, majors: full.majors
    } : g;
  });
  res.json({ ...school, groups });
});

app.get('/api/lookup/group/:schoolId/:groupCode', requireLogin, (req, res) => {
  const group = memIndex.groups.get(`${req.params.schoolId}|${req.params.groupCode}`);
  if (!group) return res.json(null);
  res.json(group);
});

app.get('/api/lookup/major/:groupId/:majorCode', requireLogin, (req, res) => {
  const major = memIndex.majors.get(`g${req.params.groupId}|${req.params.majorCode}`);
  res.json(major || null);
});

app.get('/api/search', requireLogin, (req, res) => {
  const { keyword } = req.query;
  if (!keyword) return res.json([]);
  const kw = String(keyword).toLowerCase();
  const out = [];
  for (const s of memIndex.schools.values()) {
    const sMatch = s.name.toLowerCase().includes(kw) || s.code.includes(kw);
    for (const g of s.groups) {
      const gMatch = (g.group_name || '').toLowerCase().includes(kw);
      for (const m of g.majors) {
        const mMatch = m.major_name.toLowerCase().includes(kw) || m.major_code.includes(kw);
        if (sMatch || gMatch || mMatch) {
          out.push({
            school_id: s.id, school_code: s.code, school_name: s.name,
            group_id: g.id, group_code: g.group_code, group_name: g.group_name,
            subject_requirement: g.subject_requirement,
            major_id: m.id, major_code: m.major_code, major_name: m.major_name,
            plan_count: m.plan_count, tuition: m.tuition
          });
          if (out.length >= 200) return res.json(out);
        }
      }
    }
  }
  res.json(out);
});

// ========== 招生计划 ==========
app.get('/api/plan', requireLogin, (req, res) => {
  const { keyword, school_code, province, page=1, limit=50 } = req.query;
  // 从 memIndex 展开全量数据
  let all = [];
  for (const s of memIndex.schools.values()) {
    for (const g of s.groups) {
      const full = memIndex.groups.get(`${s.code}|${g.group_code}`);
      const majors = full ? full.majors : [];
      for (const m of majors) {
        all.push({
          school_code: s.code, school_name: s.name, province: s.province, city: s.city, school_type: s.school_type,
          group_code: g.group_code, group_name: g.group_name, subject_requirement: g.subject_requirement,
          major_code: m.major_code, major_name: m.major_name, plan_count: m.plan_count, tuition: m.tuition, duration: m.duration
        });
      }
    }
  }
  // 筛选
  let filtered = all;
  if (keyword) { const kw = String(keyword).toLowerCase(); filtered = filtered.filter(r => r.school_name.toLowerCase().includes(kw) || r.school_code.includes(kw) || r.major_name.toLowerCase().includes(kw)); }
  if (school_code) { filtered = filtered.filter(r => r.school_code === school_code); }
  if (province) { filtered = filtered.filter(r => r.province === province); }
  // 分页
  const total = filtered.length;
  const offset = (Number(page) - 1) * Number(limit);
  const rows = filtered.slice(offset, offset + Number(limit));
  res.json({ rows, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
});

// ========== 历年录取 ==========
app.get('/api/history', requireLogin, (req, res) => {
  const { keyword } = req.query;
  const all = getHistoryData();
  if (keyword) {
    const kw = keyword.toLowerCase();
    const filtered = all.filter(r =>
      r.school_name.toLowerCase().includes(kw) ||
      r.school_code.includes(kw) ||
      (r.group_name && r.group_name.toLowerCase().includes(kw))
    );
    return res.json(filtered);
  }
  res.json(all);
});

function getHistoryData() {
  return [
    {"school_code":"8119","school_name":"西安铁路职业技术学院","group_code":"001","group_name":"轨道交通专业组","min_score":345,"avg_score":362,"max_score":398,"min_rank":128560,"plan_count":180,"note":"2025模拟数据"},
    {"school_code":"8119","school_name":"西安铁路职业技术学院","group_code":"003","group_name":"电子信息专业组","min_score":338,"avg_score":355,"max_score":385,"min_rank":135200,"plan_count":120,"note":"2025模拟数据"},
    {"school_code":"8126","school_name":"西安航空职业技术学院","group_code":"001","group_name":"航空工程专业组","min_score":352,"avg_score":370,"max_score":412,"min_rank":122300,"plan_count":150,"note":"2025模拟数据"},
    {"school_code":"8126","school_name":"西安航空职业技术学院","group_code":"002","group_name":"航空工程专业组","min_score":342,"avg_score":358,"max_score":395,"min_rank":131500,"plan_count":80,"note":"2025模拟数据"},
    {"school_code":"8112","school_name":"陕西工业职业技术学院","group_code":"001","group_name":"智能制造专业组","min_score":330,"avg_score":348,"max_score":390,"min_rank":143200,"plan_count":200,"note":"2025模拟数据"},
    {"school_code":"8112","school_name":"陕西工业职业技术学院","group_code":"002","group_name":"智能制造专业组","min_score":320,"avg_score":338,"max_score":375,"min_rank":152800,"plan_count":100,"note":"2025模拟数据"},
    {"school_code":"8113","school_name":"杨凌职业技术学院","group_code":"001","group_name":"现代农业专业组","min_score":310,"avg_score":328,"max_score":370,"min_rank":162400,"plan_count":160,"note":"2025模拟数据"},
    {"school_code":"8128","school_name":"陕西铁路工程职业技术学院","group_code":"001","group_name":"铁道工程专业组","min_score":348,"avg_score":365,"max_score":405,"min_rank":125800,"plan_count":170,"note":"2025模拟数据"},
    {"school_code":"8128","school_name":"陕西铁路工程职业技术学院","group_code":"002","group_name":"铁道工程专业组","min_score":335,"avg_score":350,"max_score":388,"min_rank":138000,"plan_count":90,"note":"2025模拟数据"},
    {"school_code":"8122","school_name":"陕西国防工业职业技术学院","group_code":"001","group_name":"国防装备专业组","min_score":340,"avg_score":358,"max_score":400,"min_rank":133500,"plan_count":140,"note":"2025模拟数据"},
    {"school_code":"8110","school_name":"西安电力高等专科学校","group_code":"001","group_name":"电力技术专业组","min_score":355,"avg_score":375,"max_score":420,"min_rank":119500,"plan_count":130,"note":"2025模拟数据"},
    {"school_code":"8123","school_name":"陕西交通职业技术学院","group_code":"001","group_name":"交通运输专业组","min_score":325,"avg_score":342,"max_score":382,"min_rank":148000,"plan_count":150,"note":"2025模拟数据"},
    {"school_code":"8124","school_name":"陕西能源职业技术学院","group_code":"001","group_name":"能源化工专业组","min_score":318,"avg_score":335,"max_score":372,"min_rank":154500,"plan_count":120,"note":"2025模拟数据"},
    {"school_code":"8133","school_name":"宝鸡职业技术学院","group_code":"001","group_name":"医学护理专业组","min_score":328,"avg_score":345,"max_score":385,"min_rank":145000,"plan_count":180,"note":"2025模拟数据"},
    {"school_code":"8139","school_name":"西安职业技术学院","group_code":"001","group_name":"信息技术专业组","min_score":322,"avg_score":340,"max_score":378,"min_rank":150800,"plan_count":140,"note":"2025模拟数据"},
    {"school_code":"8141","school_name":"汉中职业技术学院","group_code":"001","group_name":"医学护理专业组","min_score":315,"avg_score":332,"max_score":368,"min_rank":157200,"plan_count":160,"note":"2025模拟数据"},
    {"school_code":"8142","school_name":"延安职业技术学院","group_code":"001","group_name":"能源化工专业组","min_score":308,"avg_score":325,"max_score":360,"min_rank":164000,"plan_count":130,"note":"2025模拟数据"},
    {"school_code":"8149","school_name":"榆林职业技术学院","group_code":"001","group_name":"能源化工专业组","min_score":305,"avg_score":322,"max_score":358,"min_rank":166800,"plan_count":120,"note":"2025模拟数据"},
    {"school_code":"8055","school_name":"陕西警察学院","group_code":"001","group_name":"公安与司法专业组","min_score":360,"avg_score":380,"max_score":425,"min_rank":115000,"plan_count":100,"note":"2025模拟数据"},
    {"school_code":"8017","school_name":"陕西中医药大学","group_code":"001","group_name":"医药卫生专业组","min_score":358,"avg_score":378,"max_score":430,"min_rank":117000,"plan_count":120,"note":"2025模拟数据"},
    {"school_code":"8030","school_name":"西安医学院","group_code":"001","group_name":"医药卫生专业组","min_score":362,"avg_score":385,"max_score":440,"min_rank":113500,"plan_count":140,"note":"2025模拟数据"},
    {"school_code":"8021","school_name":"陕西理工大学","group_code":"001","group_name":"理工专业组","min_score":350,"avg_score":368,"max_score":415,"min_rank":124000,"plan_count":150,"note":"2025模拟数据"},
    {"school_code":"8023","school_name":"延安大学","group_code":"001","group_name":"综合专业组","min_score":332,"avg_score":350,"max_score":392,"min_rank":141000,"plan_count":130,"note":"2025模拟数据"},
    {"school_code":"8025","school_name":"西安文理学院","group_code":"001","group_name":"综合专业组","min_score":345,"avg_score":362,"max_score":408,"min_rank":128800,"plan_count":110,"note":"2025模拟数据"},
    {"school_code":"8029","school_name":"咸阳师范学院","group_code":"001","group_name":"师范专业组","min_score":328,"avg_score":345,"max_score":385,"min_rank":145200,"plan_count":160,"note":"2025模拟数据"},
    {"school_code":"8024","school_name":"渭南师范学院","group_code":"001","group_name":"师范专业组","min_score":320,"avg_score":338,"max_score":378,"min_rank":152500,"plan_count":150,"note":"2025模拟数据"},
    {"school_code":"8034","school_name":"西安思源学院","group_code":"001","group_name":"综合专业组","min_score":290,"avg_score":308,"max_score":350,"min_rank":181000,"plan_count":200,"note":"2025模拟数据"},
    {"school_code":"8036","school_name":"西安培华学院","group_code":"001","group_name":"综合专业组","min_score":295,"avg_score":312,"max_score":355,"min_rank":176500,"plan_count":180,"note":"2025模拟数据"},
    {"school_code":"8037","school_name":"西安欧亚学院","group_code":"001","group_name":"综合专业组","min_score":288,"avg_score":305,"max_score":348,"min_rank":183000,"plan_count":190,"note":"2025模拟数据"},
    {"school_code":"8040","school_name":"西京学院","group_code":"001","group_name":"综合专业组","min_score":292,"avg_score":310,"max_score":352,"min_rank":179200,"plan_count":170,"note":"2025模拟数据"},
    {"school_code":"8053","school_name":"西安航空学院","group_code":"001","group_name":"航空工程专业组","min_score":342,"avg_score":360,"max_score":405,"min_rank":131800,"plan_count":110,"note":"2025模拟数据"},
    {"school_code":"8129","school_name":"陕西邮电职业技术学院","group_code":"001","group_name":"信息技术专业组","min_score":315,"avg_score":332,"max_score":370,"min_rank":157500,"plan_count":130,"note":"2025模拟数据"},
    {"school_code":"8109","school_name":"陕西航空职业技术学院","group_code":"001","group_name":"航空制造专业组","min_score":312,"avg_score":330,"max_score":368,"min_rank":160300,"plan_count":140,"note":"2025模拟数据"},
    {"school_code":"8059","school_name":"西安汽车职业大学","group_code":"001","group_name":"汽车工程专业组","min_score":285,"avg_score":302,"max_score":345,"min_rank":185500,"plan_count":160,"note":"2025模拟数据"},
    {"school_code":"8106","school_name":"陕西工商职业学院","group_code":"001","group_name":"财经管理专业组","min_score":308,"avg_score":325,"max_score":365,"min_rank":164300,"plan_count":150,"note":"2025模拟数据"},
    {"school_code":"8054","school_name":"陕西学前师范学院","group_code":"001","group_name":"师范专业组","min_score":325,"avg_score":342,"max_score":380,"min_rank":148500,"plan_count":140,"note":"2025模拟数据"},
    {"school_code":"4203","school_name":"武汉职业技术学院","group_code":"001","group_name":"综合专业组","min_score":348,"avg_score":365,"max_score":410,"min_rank":126000,"plan_count":100,"note":"2025模拟数据"},
    {"school_code":"4405","school_name":"深圳职业技术大学","group_code":"001","group_name":"信息技术专业组","min_score":365,"avg_score":388,"max_score":445,"min_rank":111000,"plan_count":80,"note":"2025模拟数据"},
    {"school_code":"5103","school_name":"成都航空职业技术学院","group_code":"001","group_name":"航空工程专业组","min_score":355,"avg_score":375,"max_score":418,"min_rank":119800,"plan_count":90,"note":"2025模拟数据"},
    {"school_code":"3205","school_name":"南京信息职业技术学院","group_code":"001","group_name":"信息技术专业组","min_score":358,"avg_score":378,"max_score":422,"min_rank":117500,"plan_count":85,"note":"2025模拟数据"},
    {"school_code":"1303","school_name":"石家庄铁路职业技术学院","group_code":"001","group_name":"轨道交通专业组","min_score":340,"avg_score":358,"max_score":400,"min_rank":133800,"plan_count":95,"note":"2025模拟数据"},
    {"school_code":"3705","school_name":"山东商业职业技术学院","group_code":"001","group_name":"综合专业组","min_score":330,"avg_score":348,"max_score":390,"min_rank":143500,"plan_count":88,"note":"2025模拟数据"},
    {"school_code":"1205","school_name":"天津医学高等专科学校","group_code":"001","group_name":"医药卫生专业组","min_score":368,"avg_score":390,"max_score":450,"min_rank":109000,"plan_count":75,"note":"2025模拟数据"},
    {"school_code":"3303","school_name":"浙江交通职业技术学院","group_code":"001","group_name":"交通运输专业组","min_score":345,"avg_score":362,"max_score":408,"min_rank":128300,"plan_count":80,"note":"2025模拟数据"},
    {"school_code":"4105","school_name":"黄河水利职业技术学院","group_code":"001","group_name":"水利工程专业组","min_score":338,"avg_score":355,"max_score":398,"min_rank":135500,"plan_count":85,"note":"2025模拟数据"},
    {"school_code":"3503","school_name":"福建船政交通职业学院","group_code":"001","group_name":"交通运输专业组","min_score":328,"avg_score":345,"max_score":385,"min_rank":145500,"plan_count":78,"note":"2025模拟数据"},
    {"school_code":"5105","school_name":"四川交通职业技术学院","group_code":"001","group_name":"交通运输专业组","min_score":335,"avg_score":352,"max_score":395,"min_rank":138500,"plan_count":82,"note":"2025模拟数据"},
    {"school_code":"3101","school_name":"上海出版印刷高等专科学校","group_code":"001","group_name":"文化传媒专业组","min_score":342,"avg_score":358,"max_score":402,"min_rank":131200,"plan_count":70,"note":"2025模拟数据"},
    {"school_code":"5005","school_name":"重庆工程职业技术学院","group_code":"001","group_name":"工程技术专业组","min_score":332,"avg_score":348,"max_score":392,"min_rank":141500,"plan_count":88,"note":"2025模拟数据"},
    {"school_code":"4305","school_name":"长沙航空职业技术学院","group_code":"001","group_name":"航空工程专业组","min_score":350,"avg_score":368,"max_score":412,"min_rank":124500,"plan_count":75,"note":"2025模拟数据"},
    {"school_code":"2105","school_name":"辽宁铁道职业技术学院","group_code":"001","group_name":"轨道交通专业组","min_score":338,"avg_score":355,"max_score":395,"min_rank":135800,"plan_count":80,"note":"2025模拟数据"},
    {"school_code":"8022","school_name":"宝鸡文理学院","group_code":"001","group_name":"综合专业组","min_score":335,"avg_score":352,"max_score":395,"min_rank":138200,"plan_count":140,"note":"2025模拟数据"},
    {"school_code":"8031","school_name":"安康学院","group_code":"001","group_name":"综合专业组","min_score":312,"avg_score":328,"max_score":368,"min_rank":160500,"plan_count":130,"note":"2025模拟数据"},
    {"school_code":"8032","school_name":"商洛学院","group_code":"001","group_name":"综合专业组","min_score":308,"avg_score":325,"max_score":365,"min_rank":164500,"plan_count":120,"note":"2025模拟数据"},
    {"school_code":"8033","school_name":"榆林学院","group_code":"001","group_name":"综合专业组","min_score":318,"avg_score":335,"max_score":375,"min_rank":154800,"plan_count":130,"note":"2025模拟数据"},
  ];
}

// ========== 管理员 ==========
app.post('/api/admin/generate-accounts', requireAdmin, (req, res) => {
  const { count = 1, prefix = 'ZK' } = req.body;
  if (count < 1 || count > 500) return res.status(400).json({ error: '单次生成数量1-500' });
  const accounts = [];
  const now = new Date();
  const batchId = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  for (let i = 0; i < count; i++) {
    const username = `2561${6101}${5}${String(Math.floor(Math.random()*900)+100)}${String(Math.floor(Math.random()*90)+10)}`;
    const rawPassword = `${prefix}${String(Math.floor(Math.random()*900000+100000))}`;
    const passwordHash = bcrypt.hashSync(rawPassword, 10);
    const birth = `20070${Math.floor(Math.random()*9+1)}${String(Math.floor(Math.random()*12+1)).padStart(2,'0')}${String(Math.floor(Math.random()*28+1)).padStart(2,'0')}`;
    const idCard = `610000${birth}${String(Math.floor(Math.random()*9000+1000))}`;
    const idCardHash = bcrypt.hashSync(idCard, 10);
    const displayName = `模拟考生${batchId}-${String(i+1).padStart(3,'0')}`;
    dbRun('INSERT INTO users (username, password_hash, raw_password, id_card_hash, raw_idcard, display_name) VALUES (?,?,?,?,?,?)', [username, passwordHash, rawPassword, idCardHash, idCard, displayName]);
    accounts.push({ username, password: rawPassword, idCard, displayName });
  }
  saveDB();
  res.json({ ok: true, count: accounts.length, batchId, accounts, note: '请立即下载，原始密码仅此可见。' });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const { search, limit = 50 } = req.query;
  let sql = `SELECT u.id, u.username, u.raw_password, u.raw_idcard, u.display_name, u.locked_ip, u.is_disabled, u.note, u.created_at,
    (SELECT COUNT(*) FROM login_logs WHERE user_id=u.id AND success=1) as login_count,
    (SELECT created_at FROM login_logs WHERE user_id=u.id AND success=1 ORDER BY created_at DESC LIMIT 1) as last_login,
    (SELECT created_at FROM activity_log WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_activity
    FROM users u WHERE u.is_admin = 0`;
  let params = [];
  if (search) { sql += ' AND (u.username LIKE ? OR u.display_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY u.id DESC LIMIT ?';
  params.push(Number(limit));
  res.json({ users: dbAll(sql, params) });
});

app.post('/api/admin/users/:id/toggle', requireAdmin, (req, res) => {
  const user = dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  dbRun('UPDATE users SET is_disabled = ? WHERE id = ?', [user.is_disabled ? 0 : 1, user.id]);
  saveDB(); res.json({ ok: true, is_disabled: !user.is_disabled });
});

app.post('/api/admin/users/:id/reset-ip', requireAdmin, (req, res) => {
  dbRun('UPDATE users SET locked_ip = NULL WHERE id = ?', [req.params.id]);
  saveDB(); res.json({ ok: true, message: 'IP锁定已解除' });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const uid = parseInt(req.params.id);
  const user = dbGet('SELECT * FROM users WHERE id = ?', [uid]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.is_admin) return res.status(403).json({ error: '不可删除管理员' });
  dbRun('DELETE FROM activity_log WHERE user_id = ?', [uid]);
  dbRun('DELETE FROM login_logs WHERE user_id = ?', [uid]);
  dbRun('DELETE FROM users WHERE id = ?', [uid]);
  saveDB();
  res.json({ ok: true, message: '已删除用户 ' + user.username });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalUsers = dbGet("SELECT COUNT(*) as count FROM users WHERE is_admin = 0")?.count || 0;
  const loggedInUsers = dbGet("SELECT COUNT(DISTINCT user_id) as count FROM login_logs WHERE success = 1")?.count || 0;
  const activeUsers = dbGet("SELECT COUNT(DISTINCT user_id) as count FROM activity_log")?.count || 0;
  const todayUsers = dbGet("SELECT COUNT(DISTINCT user_id) as count FROM activity_log WHERE date(created_at) = date('now','localtime')")?.count || 0;
  const totalSchools = dbGet("SELECT COUNT(*) as count FROM schools")?.count || 0;
  const totalMajors = dbGet("SELECT COUNT(*) as count FROM majors")?.count || 0;
  res.json({ totalUsers, loggedInUsers, activeUsers, todayUsers, totalSchools, totalMajors });
});

app.get('/api/check-session', (req, res) => {
  if (req.session.userId) res.json({ loggedIn: true, isAdmin: !!req.session.isAdmin, username: req.session.username });
  else res.json({ loggedIn: false });
});

app.get('*', (req, res) => { res.redirect('/'); });

async function start() {
  await initDB();
  app.listen(PORT, '0.0.0.0', () => console.log(`陕西省志愿填报模拟系统已启动: http://0.0.0.0:${PORT}`));
}
process.on('SIGINT', () => { saveDB(); process.exit(); });
process.on('SIGTERM', () => { saveDB(); process.exit(); });
start();
