import express from 'express';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'media';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Add them to the environment before starting Coon.');
}

const supabase = createClient(SUPABASE_URL || 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY || 'missing-key', {
  auth: { autoRefreshToken: false, persistSession: false }
});

const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin.split(',').map(v => v.trim()) } : { origin: true }));
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
    cb(null, allowed.includes(file.mimetype));
  }
});

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function token(u) {
  return jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '7d' });
}

function publicUser(u) {
  return { id: u.id, username: u.username, avatar_url: u.avatar_url, bio: u.bio };
}

function normalizePost(p) {
  return {
    ...p,
    likes: p.likes?.[0]?.count || 0,
    comments: p.comments?.[0]?.count || 0,
    liked: Boolean(p.liked?.length)
  };
}

async function getPost(id, viewerId) {
  const { data, error } = await supabase
    .from('posts')
    .select(`*, user:users(id,username,avatar_url,bio), likes(count), comments(count), liked:likes!left(id,user_id)`) 
    .eq('id', id)
    .eq('likes.user_id', viewerId)
    .single();
  if (error) throw error;
  return normalizePost(data);
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'coon-backend', storage: 'supabase' }));

app.post('/api/ai/analyze', auth, (req, res) => {
  const filter = String(req.body.filter || 'Normal');
  const mode = String(req.body.mode || 'POST');
  const suggestions = {
    Normal: ['Natural light looks good. Keep the original tones.', 'Clean framing works well for this scene.'],
    Warm: ['Try Warm for a golden, friendly mood.', 'A warm tone could make this scene feel softer.'],
    Vintage: ['Vintage can add a nostalgic feel.', 'Try Vintage for a retro look.'],
    Cyber: ['Cyber can emphasize a futuristic mood.', 'Try Cyber for stronger color contrast.'],
    Neon: ['Neon can make colorful lighting pop.', 'Try Neon for an energetic night look.'],
    'B&W': ['B&W can emphasize shape and contrast.', 'Try B&W when color is distracting.'],
    Dramatic: ['Dramatic can emphasize shadows and contrast.', 'Try Dramatic for a bold look.'],
    Cool: ['Cool can give the scene a crisp blue mood.', 'Try Cool for a cooler atmosphere.']
  };
  const a = suggestions[filter] || suggestions.Normal;
  res.json({ filter, mode, message: a[Math.floor(Math.random() * a.length)] });
});

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'username must be 3-30 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

  const hash = await bcrypt.hash(password, 12);
  const { data, error } = await supabase.from('users').insert({ username, email: `${username}@coon.local`, password_hash: hash }).select().single();
  if (error) return res.status(error.code === '23505' ? 409 : 400).json({ error: error.code === '23505' ? 'Username already exists' : error.message });
  const u = publicUser(data);
  res.status(201).json({ user: u, token: token(u) });
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const { data: u, error } = await supabase.from('users').select('*').eq('username', username).single();
  if (error || !u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
  const safe = publicUser(u);
  res.json({ user: safe, token: token(safe) });
});

app.get('/api/me', auth, async (req, res) => {
  const { data, error } = await supabase.from('users').select('id,username,avatar_url,bio').eq('id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

app.post('/api/posts', auth, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'media required (jpg, png, webp, mp4, or webm)' });
    const ext = req.file.originalname.includes('.') ? req.file.originalname.split('.').pop().toLowerCase() : 'bin';
    const safeExt = ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'webm'].includes(ext) ? ext : 'bin';
    const objectPath = `posts/${req.user.id}/${crypto.randomUUID()}.${safeExt}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(objectPath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
      cacheControl: '3600'
    });
    if (uploadError) return res.status(400).json({ error: uploadError.message });

    const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
    const mediaUrl = publicData.publicUrl;
    const { filter = 'filter-none', mode = 'POST', caption = '' } = req.body;
    const { data: post, error } = await supabase.from('posts').insert({
      user_id: req.user.id,
      media_url: mediaUrl,
      media_type: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
      filter,
      mode,
      caption
    }).select('*').single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ ...post, username: req.user.username });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

app.get('/api/feed', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('posts')
    .select(`*, user:users(id,username,avatar_url,bio), likes(count), comments(count), liked:likes!left(id,user_id)`) 
    .eq('liked.user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(p => ({
    ...normalizePost(p),
    username: p.user?.username,
    avatar_url: p.user?.avatar_url
  })));
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  const id = req.params.id;
  const { data: existing } = await supabase.from('likes').select('id').eq('post_id', id).eq('user_id', req.user.id).maybeSingle();
  if (existing) {
    await supabase.from('likes').delete().eq('id', existing.id);
    return res.json({ liked: false });
  }
  const { error } = await supabase.from('likes').insert({ post_id: id, user_id: req.user.id });
  if (error) return res.status(400).json({ error: error.message });
  const { data: p } = await supabase.from('posts').select('user_id').eq('id', id).single();
  if (p && p.user_id !== req.user.id) await supabase.from('notifications').insert({ user_id: p.user_id, actor_id: req.user.id, type: 'like', post_id: id, message: 'liked your post' });
  res.json({ liked: true });
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const id = req.params.id;
  const { data: comment, error } = await supabase.from('comments').insert({ post_id: id, user_id: req.user.id, text }).select('*, user:users(username)').single();
  if (error) return res.status(400).json({ error: error.message });
  const { data: p } = await supabase.from('posts').select('user_id').eq('id', id).single();
  if (p && p.user_id !== req.user.id) await supabase.from('notifications').insert({ user_id: p.user_id, actor_id: req.user.id, type: 'comment', post_id: id, message: 'commented on your post' });
  res.status(201).json({ ...comment, username: comment.user?.username });
});

app.post('/api/users/:id/follow', auth, async (req, res) => {
  const id = req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });
  const { data: existing } = await supabase.from('follows').select('id').eq('follower_id', req.user.id).eq('following_id', id).maybeSingle();
  if (existing) {
    await supabase.from('follows').delete().eq('id', existing.id);
    return res.json({ following: false });
  }
  const { error } = await supabase.from('follows').insert({ follower_id: req.user.id, following_id: id });
  if (error) return res.status(400).json({ error: error.message });
  await supabase.from('notifications').insert({ user_id: id, actor_id: req.user.id, type: 'follow', message: 'started following you' });
  res.json({ following: true });
});

app.get('/api/notifications', auth, async (req, res) => {
  const { data, error } = await supabase.from('notifications').select('*, actor:users(username,avatar_url)').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(n => ({ ...n, username: n.actor?.username, avatar_url: n.actor?.avatar_url })));
});

app.get('/api/users/:username', auth, async (req, res) => {
  const { data: u, error } = await supabase.from('users').select('id,username,avatar_url,bio').eq('username', req.params.username).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  const [{ data: posts }, { count: followers }, { count: following }] = await Promise.all([
    supabase.from('posts').select('*').eq('user_id', u.id).order('created_at', { ascending: false }),
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', u.id),
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', u.id)
  ]);
  res.json({ ...u, posts: posts || [], followers: followers || 0, following: following || 0 });
});

app.get('/api/messages/:userId', auth, async (req, res) => {
  const other = req.params.userId;
  const { data, error } = await supabase.from('messages').select('*, sender:users(username)').or(`and(sender_id.eq.${req.user.id},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${req.user.id})`).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(m => ({ ...m, username: m.sender?.username })));
});

app.post('/api/messages/:userId', auth, async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const receiver_id = req.params.userId;
  const { data: msg, error } = await supabase.from('messages').insert({ sender_id: req.user.id, receiver_id, text }).select('*').single();
  if (error) return res.status(400).json({ error: error.message });
  await supabase.from('notifications').insert({ user_id: receiver_id, actor_id: req.user.id, type: 'message', message: 'sent you a message' });
  broadcast(receiver_id, { type: 'message', message: msg });
  res.status(201).json(msg);
});

const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map();
wss.on('connection', (ws, req) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const t = u.searchParams.get('token');
    const user = jwt.verify(t, JWT_SECRET);
    sockets.set(user.id, ws);
    ws.on('close', () => { if (sockets.get(user.id) === ws) sockets.delete(user.id); });
  } catch { ws.close(); }
});
function broadcast(uid, payload) {
  const ws = sockets.get(uid);
  if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
}

server.listen(PORT, '0.0.0.0', () => console.log(`Coon API running on port ${PORT}`));
