// Port of supabase/functions/parse-pdf-to-json.
// Submit mode: POST multipart form with `file` or `pdf_url` -> sends it to Datalab (Marker) and
// returns a request_id to poll. Poll mode: ?request_id=<id>[&skip_images=true] -> checks Datalab,
// and when complete uploads extracted images to Backblaze B2 and registers them in question_images.
//
// Not behind auth, as in the original. Endpoints are configurable for tests and staging:
// DATALAB_API_BASE and B2_API_BASE (defaults are the public hosts).
import express from "express";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { query } from "../_shared/db.js";

const DEFAULT_DATALAB_BASE = "https://www.datalab.to/api/v1";
const DEFAULT_B2_API_BASE = "https://api.backblazeb2.com";

export const router = express.Router();

const datalabBase = () => (process.env.DATALAB_API_BASE || DEFAULT_DATALAB_BASE).replace(/\/$/, "");
const b2Base = () => (process.env.B2_API_BASE || DEFAULT_B2_API_BASE).replace(/\/$/, "");

const jsonRes = (res, body, status = 200) => res.status(status).json(body);

// Backblaze B2 native API: authorize, then get a download authorization for a path prefix.
async function b2Authorize() {
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APPLICATION_KEY;
  const r = await fetch(`${b2Base()}/b2api/v2/b2_authorize_account`, {
    method: "GET",
    headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") },
  });
  return r;
}

// Signed download URL for a private B2 file, valid for one hour.
async function getB2DownloadUrl(filePath) {
  const bucketName = process.env.B2_BUCKET_NAME || "Simplelecture";
  if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY) {
    throw new Error("B2 credentials not configured");
  }
  const authResponse = await b2Authorize();
  if (!authResponse.ok) throw new Error("Failed to authorize with B2");
  const { authorizationToken, apiUrl, downloadUrl } = await authResponse.json();

  const downloadAuthResponse = await fetch(`${apiUrl}/b2api/v2/b2_get_download_authorization`, {
    method: "POST",
    headers: { Authorization: authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      bucketId: process.env.B2_BUCKET_ID,
      fileNamePrefix: filePath,
      validDurationInSeconds: 3600,
    }),
  });
  if (!downloadAuthResponse.ok) throw new Error("Failed to get B2 download authorization");
  const downloadAuthData = await downloadAuthResponse.json();
  return `${downloadUrl}/file/${bucketName}/${filePath}?Authorization=${downloadAuthData.authorizationToken}`;
}

// Uploads one base64 image to B2. Returns { b2Path } or null (never throws).
async function uploadImageToB2(base64Data, imageName, requestId) {
  try {
    const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "");
    let contentType = "image/png";
    let extension = "png";
    if (base64Data.includes("data:image/jpeg") || base64Data.includes("data:image/jpg")) {
      contentType = "image/jpeg";
      extension = "jpg";
    } else if (base64Data.includes("data:image/webp")) {
      contentType = "image/webp";
      extension = "webp";
    }
    const bytes = Buffer.from(base64Clean, "base64");

    const bucketId = process.env.B2_BUCKET_ID;
    if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !bucketId) {
      console.error("B2 credentials not configured, skipping B2 upload");
      return null;
    }

    const authResponse = await b2Authorize();
    if (!authResponse.ok) {
      console.error("B2 auth failed:", authResponse.status);
      return null;
    }
    const authData = await authResponse.json();

    const uploadUrlResponse = await fetch(`${authData.apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: "POST",
      headers: { Authorization: authData.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({ bucketId }),
    });
    if (!uploadUrlResponse.ok) {
      console.error("B2 get upload URL failed:", uploadUrlResponse.status);
      return null;
    }
    const uploadUrlData = await uploadUrlResponse.json();

    const sha1Hash = createHash("sha1").update(bytes).digest("hex");
    const safeImageName = imageName.includes(".") ? imageName : `${imageName}.${extension}`;
    const b2FilePath = `question-images/extracted/${requestId}/${safeImageName}`;
    const encodedPath = b2FilePath.split("/").map((s) => encodeURIComponent(s)).join("/");

    const uploadResponse = await fetch(uploadUrlData.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: uploadUrlData.authorizationToken,
        "X-Bz-File-Name": encodedPath,
        "Content-Type": contentType,
        "Content-Length": bytes.length.toString(),
        "X-Bz-Content-Sha1": sha1Hash,
      },
      body: bytes,
    });
    if (!uploadResponse.ok) {
      console.error(`B2 upload failed for ${imageName}: ${uploadResponse.status}`);
      return null;
    }
    console.log(`Uploaded ${imageName} to B2`);
    return { b2Path: b2FilePath };
  } catch (error) {
    console.error(`Error uploading image ${imageName} to B2:`, error?.message);
    return null;
  }
}

// Registers uploaded images in question_images. Existing storage_path rows are left alone.
async function registerImages(rows) {
  const values = [];
  const params = [];
  rows.forEach((row, i) => {
    const b = i * 4;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
    params.push(row.original_filename, row.storage_path, row.public_url, row.datalab_request_id);
  });
  try {
    await query(
      `INSERT INTO public.question_images (original_filename, storage_path, public_url, datalab_request_id)
       VALUES ${values.join(", ")}
       ON CONFLICT (storage_path) DO NOTHING`,
      params
    );
    console.log(`Registered ${rows.length} images in question_images table (B2 paths)`);
  } catch (err) {
    console.error("Failed to register images in lookup table:", err.message);
  }
}

// Turns the Express request into a Web Request so the multipart body can be read with formData().
function toWebRequest(req) {
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  });
}

async function handlePoll(req, res, pollRequestId, skipImages) {
  const apiKey = process.env.DATALAB_API_KEY;
  console.log(`Polling status for request: ${pollRequestId}, skipImages: ${skipImages}`);

  const statusResponse = await fetch(`${datalabBase()}/convert/${encodeURIComponent(pollRequestId)}`, {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  });
  if (!statusResponse.ok) {
    console.error("Status check failed:", statusResponse.status);
    return jsonRes(res, { status: "error", message: "Failed to check status" }, 500);
  }

  const result = await statusResponse.json();
  console.log("Poll result status:", result.status);

  if (result.status === "complete") {
    const pageCount = result.page_count ?? result.metadata?.pages ?? 0;
    const imageUrls = {};
    const uploadedImages = [];

    if (!skipImages && result.images && Object.keys(result.images).length > 0) {
      console.log("Uploading extracted images to B2...");
      const entries = Object.entries(result.images);
      for (let i = 0; i < entries.length; i++) {
        const [imageName, base64Data] = entries[i];
        const b2Result = await uploadImageToB2(base64Data, imageName, pollRequestId);
        if (b2Result) {
          imageUrls[imageName] = b2Result.b2Path;
          uploadedImages.push({ b2Path: b2Result.b2Path, pageNumber: i + 1, name: imageName });
        }
      }
      if (uploadedImages.length > 0) {
        await registerImages(
          uploadedImages.map((img) => ({
            original_filename: img.name.includes(".") ? img.name : `${img.name}.png`,
            storage_path: img.b2Path,
            public_url: img.b2Path,
            datalab_request_id: pollRequestId,
          }))
        );
      }
    } else if (skipImages) {
      console.log("Skipping image uploads (skip_images=true)");
    }

    return jsonRes(res, {
      success: true,
      status: "complete",
      request_id: pollRequestId,
      content_json: result.json || null,
      content_markdown: result.markdown || null,
      images: imageUrls,
      uploaded_images: uploadedImages,
      metadata: { pages: pageCount, ocr_stats: result.metadata?.ocr_stats || null },
    });
  }
  if (result.status === "failed") {
    return jsonRes(res, { success: false, status: "failed", message: "Processing failed" }, 500);
  }
  return jsonRes(res, { success: true, status: result.status, request_id: pollRequestId });
}

async function handleSubmit(req, res) {
  if (req.method !== "POST") {
    return jsonRes(res, { error: "POST with file/pdf_url or GET with request_id required" }, 400);
  }
  const formData = await toWebRequest(req).formData();
  const file = formData.get("file");
  let pdfUrl = formData.get("pdf_url");

  if (!file && !pdfUrl) return jsonRes(res, { error: "Either file or pdf_url is required" }, 400);

  console.log("Starting PDF parsing with Datalab Marker API...");
  if (pdfUrl && !String(pdfUrl).startsWith("http")) {
    console.log("Converting B2 path to signed URL...");
    pdfUrl = await getB2DownloadUrl(String(pdfUrl));
  }

  const datalabFormData = new FormData();
  if (file) {
    datalabFormData.append("file", file, file.name);
  } else {
    datalabFormData.append("file_url", pdfUrl);
  }
  datalabFormData.append("output_format", "markdown");
  datalabFormData.append("mode", "balanced");
  datalabFormData.append("paginate", "false");
  datalabFormData.append("skip_cache", "true");

  const submitResponse = await fetch(`${datalabBase()}/convert`, {
    method: "POST",
    headers: { "X-API-Key": process.env.DATALAB_API_KEY },
    body: datalabFormData,
  });
  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    console.error("Datalab submit error:", submitResponse.status);
    throw new Error(`Datalab API error: ${submitResponse.status} - ${errorText}`);
  }
  const submitResult = await submitResponse.json();
  const requestId = submitResult.request_id;
  if (!requestId) throw new Error("No request_id received from Datalab");

  return jsonRes(res, {
    success: true,
    status: "processing",
    request_id: requestId,
    message: "PDF submitted for processing. Poll with ?request_id=<id> to check status.",
  });
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    if (!process.env.DATALAB_API_KEY) throw new Error("DATALAB_API_KEY is not configured");

    const pollRequestId = req.query.request_id;
    if (pollRequestId) {
      return await handlePoll(req, res, String(pollRequestId), req.query.skip_images === "true");
    }
    return await handleSubmit(req, res);
  } catch (error) {
    const details = error instanceof Error ? error.message : "Unknown error";
    console.error("Error parsing PDF:", details);
    return jsonRes(res, { error: "Failed to parse PDF", details }, 500);
  }
});

export default router;
