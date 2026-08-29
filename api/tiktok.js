
const crypto = require("crypto");

const TIKWM_API = "https://www.tikwm.com/api/";
const SECRET =
  process.env.DOWNLOAD_SECRET ||
  "change-this-secret-before-production-9f6c2d8a";

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function sign(payload) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("base64url");
}

function createToken(url, filename) {
  const payload = Buffer.from(
    JSON.stringify({
      url,
      filename,
      exp: Date.now() + 10 * 60 * 1000
    })
  ).toString("base64url");

  return payload + "." + sign(payload);
}

function readToken(token) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const payload = parts[0];
  const signature = parts[1];
  const expected = sign(payload);

  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  ) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (!data.url || !data.exp || Date.now() > data.exp) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function isTikTokUrl(value) {
  try {
    const u = new URL(value);

    return (
      /(^|\.)tiktok\.com$/i.test(u.hostname) ||
      /(^|\.)vm\.tiktok\.com$/i.test(u.hostname) ||
      /(^|\.)vt\.tiktok\.com$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

function isAllowedMediaUrl(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === "https:" &&
      (
        /(^|\.)tiktokcdn\.com$/i.test(u.hostname) ||
        /(^|\.)tiktokcdn-us\.com$/i.test(u.hostname) ||
        /(^|\.)tiktokcdn-eu\.com$/i.test(u.hostname) ||
        /(^|\.)ibytedtos\.com$/i.test(u.hostname) ||
        /(^|\.)muscdn\.com$/i.test(u.hostname) ||
        /(^|\.)tikwm\.com$/i.test(u.hostname)
      )
    );
  } catch {
    return false;
  }
}

function safeFilename(name, fallback) {
  const clean = String(name || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return clean || fallback;
}

function createDownloadUrl(url, filename) {
  if (!url || !isAllowedMediaUrl(url)) return null;

  const token = createToken(url, filename);

  return "api/tiktok?download=" + encodeURIComponent(token);
}

async function getTikTokData(tiktokUrl) {
  const apiUrl =
    TIKWM_API + "?url=" + encodeURIComponent(tiktokUrl);

  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error("TikWM HTTP " + response.status);
  }

  const json = await response.json();

  if (json.code !== 0 || !json.data) {
    throw new Error(
      json.msg || "Media TikTok tidak ditemukan."
    );
  }

  return json;
}

function rewriteData(data) {
  const d = { ...data };

  const description = (
    d.desc ||
    d.description ||
    d.title ||
    ""
  ).trim();

  const video = d.play || d.wmplay;

  if (video && isAllowedMediaUrl(video)) {
    d.play = createDownloadUrl(
      video,
      "tiktok-video.mp4"
    );

    if (d.wmplay) {
      d.wmplay = createDownloadUrl(
        d.wmplay,
        "tiktok-video.mp4"
      );
    }
  }

  const audio =
    d.music ||
    (d.music_info && d.music_info.play);

  if (audio && isAllowedMediaUrl(audio)) {
    d.music = createDownloadUrl(
      audio,
      "tiktok-sound.mp3"
    );

    if (d.music_info) {
      d.music_info = {
        ...d.music_info,
        play: createDownloadUrl(
          audio,
          "tiktok-sound.mp3"
        )
      };
    }
  }

  const images =
    d.images ||
    (d.image_post_info &&
      d.image_post_info.images) ||
    [];

  if (Array.isArray(images)) {
    d.images = images.map((img, index) => {
      const original =
        typeof img === "string"
          ? img
          : img &&
            (
              img.url ||
              img.display_url ||
              img.origin_url
            );

      const downloadUrl = createDownloadUrl(
        original,
        "tiktok-foto-" + (index + 1) + ".jpg"
      );

      if (typeof img === "string") {
        return downloadUrl;
      }

      if (downloadUrl) {
        return {
          ...img,
          url: downloadUrl,
          display_url: downloadUrl,
          origin_url: downloadUrl
        };
      }

      return img;
    });

    if (
      d.image_post_info &&
      d.image_post_info.images
    ) {
      d.image_post_info = {
        ...d.image_post_info,
        images: d.images
      };
    }
  }

  d.desc = description;

  return d;
}

async function downloadMedia(res, token) {
  const data = readToken(token);

  if (!data) {
    return sendJson(res, 400, {
      code: -1,
      msg: "Link download tidak valid atau sudah kedaluwarsa."
    });
  }

  if (!isAllowedMediaUrl(data.url)) {
    return sendJson(res, 403, {
      code: -1,
      msg: "Sumber media tidak diizinkan."
    });
  }

  const response = await fetch(data.url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "*/*"
    }
  });

  if (!response.ok) {
    return sendJson(res, response.status, {
      code: -1,
      msg:
        "Gagal mengambil file media (HTTP " +
        response.status +
        ")."
    });
  }

  const contentType =
    response.headers.get("content-type") ||
    "application/octet-stream";

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  res.statusCode = 200;

  res.setHeader(
    "Content-Type",
    contentType.split(";")[0]
  );

  res.setHeader(
    "Content-Disposition",
    'attachment; filename="' +
      safeFilename(
        data.filename,
        "tiktok-download"
      ) +
      '"'
  );

  res.setHeader(
    "Cache-Control",
    "no-store, private"
  );

  res.end(buffer);
}

module.exports = async (req, res) => {
  try {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, OPTIONS"
    );

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "GET") {
      return sendJson(res, 405, {
        code: -1,
        msg: "Method tidak diizinkan."
      });
    }

    // MODE DOWNLOAD
    if (req.query && req.query.download) {
      return await downloadMedia(
        res,
        req.query.download
      );
    }

    // MODE AMBIL DATA TIKTOK
    const tiktokUrl = String(
      (req.query && req.query.url) || ""
    ).trim();

    if (!tiktokUrl) {
      return sendJson(res, 400, {
        code: -1,
        msg: "Parameter url wajib diisi."
      });
    }

    if (!isTikTokUrl(tiktokUrl)) {
      return sendJson(res, 400, {
        code: -1,
        msg: "URL harus berupa link TikTok yang valid."
      });
    }

    const result = await getTikTokData(
      tiktokUrl
    );

    result.data = rewriteData(result.data);

    return sendJson(res, 200, result);
  } catch (error) {
    console.error(error);

    return sendJson(res, 500, {
      code: -1,
      msg:
        error.message ||
        "Terjadi kesalahan pada server."
    });
  }
};
