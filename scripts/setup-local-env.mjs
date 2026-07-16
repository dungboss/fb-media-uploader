// `npm run setup` — dựng .env cho máy mới và nói thẳng còn thiếu gì.
//
// Tồn tại vì ba thứ trong dự án này hỏng theo kiểu IM LẶNG, không báo lỗi:
//   1. Thiếu TOKEN_ENCRYPTION_KEY  → thêm token thất bại, không rõ lý do
//   2. Redis chưa chạy             → dashboard treo ở "Đang tải token..."
//   3. Chỉ chạy `npm run dev`      → batch nằm im mãi vì không có worker
// Script này bắt cả ba TRƯỚC khi bạn mất thời gian đoán.
//
// An toàn khi chạy lại nhiều lần: không bao giờ ghi đè giá trị đã có,
// không bao giờ in ra bí mật.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const EXAMPLE_PATH = join(ROOT, ".env.example");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function readEnvValue(text, key) {
  const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function setEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  return new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text.trimEnd()}\n${line}\n`;
}

// Cổng TCP, không dùng ioredis: script này phải chạy được kể cả khi
// npm install chưa xong, và một cú bắt tay TCP là đủ để trả lời "Redis có
// đang nghe không".
function checkTcp(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function main() {
  console.log(bold("\n  Thiết lập fb-media-uploader\n"));

  // 1. .env
  if (!existsSync(ENV_PATH)) {
    if (!existsSync(EXAMPLE_PATH)) {
      console.log(red("  ✗ Không tìm thấy .env.example — repo bị thiếu file?"));
      process.exit(1);
    }
    writeFileSync(ENV_PATH, readFileSync(EXAMPLE_PATH, "utf8"));
    console.log(green("  ✓ Đã tạo .env từ .env.example"));
  } else {
    console.log("  · .env đã có, giữ nguyên các giá trị bạn đã điền");
  }

  let env = readFileSync(ENV_PATH, "utf8");

  // 2. TOKEN_ENCRYPTION_KEY — sinh nếu trống.
  // KHÔNG BAO GIỜ tự đổi khi đã có: đổi khoá này làm mọi token đã lưu thành
  // rác không giải mã được, và không có đường khôi phục.
  if (!readEnvValue(env, "TOKEN_ENCRYPTION_KEY")) {
    env = setEnvValue(env, "TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    writeFileSync(ENV_PATH, env);
    console.log(green("  ✓ Đã sinh TOKEN_ENCRYPTION_KEY"));
    console.log("    " + yellow("Đừng bao giờ đổi khoá này — đổi là mất hết token đã lưu."));
  } else {
    console.log("  · TOKEN_ENCRYPTION_KEY đã có (không đụng vào)");
  }

  // 3. Redis
  const redisUrl = readEnvValue(env, "REDIS_URL") || "redis://localhost:6379";
  const parsed = new URL(redisUrl);
  const port = Number(parsed.port || 6379);
  const host = parsed.hostname || "127.0.0.1";
  const redisUp = await checkTcp(host, port);

  console.log("");
  if (redisUp) {
    console.log(green(`  ✓ Redis đang chạy ở ${host}:${port}`));
  } else {
    console.log(red(`  ✗ Redis KHÔNG chạy ở ${host}:${port}`));
    console.log("    Chạy: " + bold("docker compose up -d"));
    console.log("    (Không có Redis, dashboard sẽ treo ở \"Đang tải token...\")");
  }

  // 4. WebDAV — phải tự điền, không đoán hộ được
  const missing = ["WEBDAV_USERNAME", "WEBDAV_PASSWORD"].filter((k) => !readEnvValue(env, k));
  if (missing.length) {
    console.log("");
    console.log(yellow(`  ! Cần điền tay vào .env: ${missing.join(", ")}`));
    console.log("    Đây là tài khoản NAS — hỏi người quản trị NAS.");
  }

  console.log("");
  console.log(bold("  Tiếp theo:"));
  if (!redisUp) console.log("    1. docker compose up -d");
  console.log(`    ${!redisUp ? "2" : "1"}. npm run dev:all      ` + "# chạy CẢ web lẫn worker");
  console.log(`    ${!redisUp ? "3" : "2"}. mở http://localhost:3000 → thêm token Facebook`);
  console.log("");
  console.log("  Lưu ý: " + bold("npm run dev") + " chỉ chạy web — batch sẽ nằm im vì không có worker.");
  console.log("  Dùng " + bold("npm run dev:all") + ".\n");
}

main();
