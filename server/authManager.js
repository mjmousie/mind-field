const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'mindfield-dev-secret-change-in-production';

async function registerHost({ fullName, displayName, email, password }) {
  if (!fullName || !displayName || !email || !password) {
    throw new Error('All fields are required');
  }

  if (await db.findHostByEmail(email)) {
    throw new Error('An account with that email already exists');
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const host = await db.insertHost({
    full_name:     fullName,
    display_name:  displayName,
    email,
    password_hash: passwordHash
  });

  return { id: host.id, displayName: host.display_name, email: host.email };
}

async function loginHost({ email, password }) {
  if (!email || !password) throw new Error('Email and password are required');

  const host = await db.findHostByEmail(email);
  if (!host) throw new Error('Invalid email or password');

  if (!bcrypt.compareSync(password, host.password_hash)) {
    throw new Error('Invalid email or password');
  }

  const token = jwt.sign(
    { id: host.id, displayName: host.display_name, email: host.email },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  return {
    token,
    host: { id: host.id, displayName: host.display_name, email: host.email }
  };
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

async function getHostById(id) {
  const h = await db.findHostById(id);
  if (!h) return null;
  return { id: h.id, full_name: h.full_name, display_name: h.display_name, email: h.email };
}

module.exports = { registerHost, loginHost, verifyToken, getHostById };
