// Bucket policy for the local storage routes, in one place.
// public: true means GET /storage/v1/object/public/<bucket>/<path> serves the file without a login.
// maxBytes: largest accepted upload. allowedTypes: file extensions (lowercase) that may be uploaded.
// Internal backend code calls upload()/readFile() directly and is not limited by this map.
const MB = 1024 * 1024;
const IMAGES = ["png", "jpg", "jpeg", "gif", "webp"];
const DOCS = ["pdf", "doc", "docx", "txt"];
const AUDIO = ["mp3", "wav", "ogg", "webm", "m4a"];

export const BUCKETS = {
  // Forum attachments: the website shows images inline and links to the rest.
  "chat-files": { public: true, maxBytes: 10 * MB, allowedTypes: [...IMAGES, ...DOCS] },
  // Images the website displays directly by public URL.
  "course-thumbnails": { public: true, maxBytes: 10 * MB, allowedTypes: IMAGES },
  "question-images": { public: true, maxBytes: 10 * MB, allowedTypes: IMAGES },
  "blog-images": { public: true, maxBytes: 10 * MB, allowedTypes: IMAGES },
  "category-icons": { public: true, maxBytes: 5 * MB, allowedTypes: IMAGES },
  "group-avatars": { public: true, maxBytes: 5 * MB, allowedTypes: IMAGES },
  "pdf-images": { public: true, maxBytes: 10 * MB, allowedTypes: IMAGES },
  "student-answers": { public: true, maxBytes: 10 * MB, allowedTypes: [...IMAGES, "pdf"] },
  "previous-year-papers": { public: true, maxBytes: 50 * MB, allowedTypes: ["pdf"] },
  "presentation-audio": { public: true, maxBytes: 50 * MB, allowedTypes: AUDIO },
  // Private: the website reads these through signed links or the backend only.
  "uploaded-question-documents": { public: false, maxBytes: 50 * MB, allowedTypes: DOCS },
  "temp-uploads": { public: false, maxBytes: 200 * MB, allowedTypes: [...IMAGES, ...DOCS, ...AUDIO, "mp4", "mov"] },
  "reminder-audio": { public: false, maxBytes: 50 * MB, allowedTypes: AUDIO },
  "reminder-audio-test": { public: false, maxBytes: 50 * MB, allowedTypes: AUDIO },
  "thumb-cache": { public: false, maxBytes: 10 * MB, allowedTypes: IMAGES },
};

// Returns the policy for a bucket name, or null when the bucket is unknown.
export function bucketPolicy(bucket) {
  return Object.prototype.hasOwnProperty.call(BUCKETS, bucket) ? BUCKETS[bucket] : null;
}

const CONTENT_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

// Content-Type sent when serving a file, from its extension.
export function contentTypeFor(ext) {
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// Extension used to check an upload when the object path has none, from the MIME type.
export function extensionForMime(mime) {
  const wanted = String(mime || "").split(";")[0].trim().toLowerCase();
  if (wanted === "image/jpeg") return "jpg";
  return Object.keys(CONTENT_TYPES).find((ext) => CONTENT_TYPES[ext].split(";")[0] === wanted) || "";
}

// Lowercase extension of the last path segment, or "".
export function extensionOf(objectPath) {
  const name = String(objectPath).split("/").pop();
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}
