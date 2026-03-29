const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'economy_data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch {}
  return { users: {} };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getUser(userId) {
  const data = loadData();
  if (!data.users[userId]) {
    data.users[userId] = { balance: 0, lastDaily: null, lastWork: null };
    saveData(data);
  }
  return data.users[userId];
}

function getBalance(userId) {
  return getUser(userId).balance;
}

function setBalance(userId, amount) {
  const data = loadData();
  if (!data.users[userId]) data.users[userId] = { balance: 0, lastDaily: null, lastWork: null };
  data.users[userId].balance = Math.max(0, Math.floor(amount));
  saveData(data);
}

function addBalance(userId, amount) {
  setBalance(userId, getBalance(userId) + amount);
}

function removeBalance(userId, amount) {
  setBalance(userId, getBalance(userId) - amount);
}

function canClaimDaily(userId) {
  const user = getUser(userId);
  if (!user.lastDaily) return true;
  return Date.now() - user.lastDaily >= 24 * 60 * 60 * 1000;
}

function claimDaily(userId) {
  const data = loadData();
  if (!data.users[userId]) data.users[userId] = { balance: 0, lastDaily: null, lastWork: null };
  const amount = Math.floor(Math.random() * 401) + 100; // 100–500
  data.users[userId].balance += amount;
  data.users[userId].lastDaily = Date.now();
  saveData(data);
  return amount;
}

function dailyCooldownLeft(userId) {
  const user = getUser(userId);
  const ms = 24 * 60 * 60 * 1000 - (Date.now() - user.lastDaily);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function canWork(userId) {
  const user = getUser(userId);
  if (!user.lastWork) return true;
  return Date.now() - user.lastWork >= 60 * 60 * 1000;
}

function doWork(userId) {
  const data = loadData();
  if (!data.users[userId]) data.users[userId] = { balance: 0, lastDaily: null, lastWork: null };
  const amount = Math.floor(Math.random() * 151) + 50; // 50–200
  data.users[userId].balance += amount;
  data.users[userId].lastWork = Date.now();
  saveData(data);
  return amount;
}

function workCooldownLeft(userId) {
  const user = getUser(userId);
  const ms = 60 * 60 * 1000 - (Date.now() - user.lastWork);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function getLeaderboard() {
  const data = loadData();
  return Object.entries(data.users)
    .sort((a, b) => b[1].balance - a[1].balance)
    .slice(0, 10);
}

module.exports = {
  getBalance,
  setBalance,
  addBalance,
  removeBalance,
  canClaimDaily,
  claimDaily,
  dailyCooldownLeft,
  canWork,
  doWork,
  workCooldownLeft,
  getLeaderboard
};
