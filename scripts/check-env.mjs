/* Pre-flight check (runs before npm run dev / start / seed): clear messages instead of cryptic stack traces. */
const [major, minor] = process.versions.node.split('.').map(Number);
const ok = major > 22 || (major === 22 && minor >= 13);
if (!ok) {
  console.error(`\n✘ Node.js ${process.versions.node} is too old.\n  This project needs Node.js 22.13 or newer (built-in SQLite + Vite 8).\n  Install the current LTS from https://nodejs.org (or: nvm install 22 && nvm use 22), then run npm install again.\n`);
  process.exit(1);
}
try {
  await import('node:sqlite');
} catch (e) {
  console.error(`\n✘ node:sqlite is not available in this Node.js build (${process.versions.node}): ${e.message}\n  Install the official Node.js 22 LTS or 24 from https://nodejs.org.\n`);
  process.exit(1);
}
console.log(`✔ Node.js ${process.versions.node} — OK`);
