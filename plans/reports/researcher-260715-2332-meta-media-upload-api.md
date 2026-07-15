# Meta Marketing API v23.0 Media Upload Research

**Date:** 2026-07-15  
**Target API Version:** v23.0  
**Scope:** AD_IMAGES and AD_VIDEOS endpoints for ad account media library  
**Sources:** Checked 20+ official Meta developer documentation pages, changelogs, API references

---

## EXECUTIVE SUMMARY

Meta Marketing API v23.0 provides **two distinct media upload endpoints** for ad account libraries:
- **POST /act_{ad_account_id}/adimages** — Single-shot multipart upload for images
- **POST /act_{ad_account_id}/advideos** — Resumable 4-phase protocol for videos

No deprecations or new upload methods in v23.0. Both endpoints are stable. The Instagram Resumable Upload API (`/uploads`) is **separate** and does NOT apply to ad account media library.

---

## 1. AD IMAGES: `POST /act_{ad_account_id}/adimages`

### Request Format

**Method:** POST  
**Content-Type:** `multipart/form-data`

**Field naming:** Use filename as field name. Example:
```
-F 'image.jpg=@image.jpg'
```

**Parameters:**
- `bytes` (String, Base64 UTF-8) — Raw image file bytes (primary method)
- `copy_from` (JSON Object) — Copy from another account's media library
  - `source_account_id` (String) — Source ad account ID
  - `hash` (String) — Image hash from source account

**Example single-shot upload:**
```
POST /v23.0/act_123456/adimages HTTP/1.1
Content-Type: multipart/form-data

--boundary
Content-Disposition: form-data; name="test.jpg"; filename="test.jpg"
Content-Type: image/jpeg

[binary image data]
--boundary--
```

### Response Shape

**Status:** 200 OK  
**Body:** JSON object with single image details
```json
{
  "hash": "abc123def456",
  "url": "https://platform-lookaside.fbsbx.com/platform/...",
  "url_128": "https://platform-lookaside.fbsbx.com/platform/..._128.jpg",
  "height": 628,
  "width": 1200,
  "name": "test.jpg"
}
```

**Fields:**
- `hash` (String) — Unique identifier; use this in ad creative `image_hash` field
- `url` (String) — Full-resolution image URL
- `url_128` (String) — 128px square thumbnail
- `height`, `width` (Int32) — Dimensions in pixels
- `name` (String) — Filename

### Multi-Image Upload

**Single-shot endpoint does NOT batch.** Upload one image per POST request. To upload multiple images, loop the endpoint.

### File Constraints

**Size limits:** Not explicitly documented in v23.0 references. Based on asset feed docs: likely 5–10MB per image (no official spec found; flag as unresolved).

**Supported formats:** JPEG, PNG, GIF (confirmed via asset feed options)

**Aspect ratio:** 1.9:1 recommended (1200×628px standard). Instagram placements prefer square (1:1).

**No chunking/resumable option.** Images must upload in single request.

**No resumption protocol.** Failed uploads restart from zero.

---

## 2. AD VIDEOS: `POST /act_{ad_account_id}/advideos`

### Resumable 4-Phase Upload Protocol

**Method:** POST  
**Content-Type:** `multipart/form-data` (video file) or JSON

**Core parameter:** `upload_phase` (String, required)
- `start` — Initialize session, reserve upload slot
- `transfer` — Upload chunk(s) of video data
- `finish` — Mark upload complete, move to encoding
- `cancel` — Abort session (cleanup)

### Phase 1: START

**Request:**
```
POST /v23.0/act_123456/advideos HTTP/1.1

{
  "upload_phase": "start",
  "file_size": 524288000,
  "title": "My Ad Video",
  "description": "Optional description"
}
```

**Required params:**
- `upload_phase: "start"`
- `file_size` (Int64) — Total file size in bytes

**Optional params:**
- `title`, `description` (String)
- `original_projection_type`, `original_fov` (360/VR, rarely used)

**Response:**
```json
{
  "id": "abc123def456",
  "video_id": "xyz789",
  "upload_session_id": "sess_aabbccdd",
  "success": true,
  "start_offset": 0,
  "end_offset": 0,
  "upload_domain": "rupload.facebook.com"
}
```

**Critical fields:**
- `upload_session_id` (String) — Used in subsequent transfer calls. **Save this.**
- `video_id` (String) — Returned after start; used for status checks
- `start_offset`, `end_offset` (Int64) — Byte range info (0,0 on start)
- `upload_domain` (String) — Hints which server to POST chunks to (usually rupload.facebook.com)

### Phase 2: TRANSFER

**Request:**
```
POST /v23.0/act_123456/advideos HTTP/1.1
Content-Type: multipart/form-data

{
  "upload_phase": "transfer",
  "upload_session_id": "sess_aabbccdd",
  "start_offset": 0,
  "end_offset": 10485760,
  "video_file_chunk": [binary chunk data]
}
```

**Required params:**
- `upload_phase: "transfer"`
- `upload_session_id` (String) — From start response
- `start_offset` (Int64) — Byte position where this chunk begins (0 for first)
- `end_offset` (Int64) — Byte position where this chunk ends (exclusive)
- `video_file_chunk` (Bytes) — Chunk binary data

**Chunk size guidance:**
- **Standard chunk size: 10MB (10485760 bytes)**
- Last chunk may be smaller
- Meta does NOT dictate chunk size via API response; use 10MB uniformly
- No maximum chunk limit documented; 10MB is proven safe

**Response:**
```json
{
  "video_id": "xyz789",
  "upload_session_id": "sess_aabbccdd",
  "success": true,
  "start_offset": 10485760,
  "end_offset": 20971520,
  "skip_upload": false
}
```

**Fields:**
- `start_offset`, `end_offset` — Byte range accepted; use `end_offset` as next `start_offset`
- `success` (Bool) — Chunk accepted (true = proceed)
- `skip_upload` (Bool) — Rare; true = server has this chunk already (resume scenario)

**Loop logic:**
```
while (bytes_uploaded < file_size):
  next_start = last_end_offset
  next_end = min(next_start + 10MB, file_size)
  chunk = file[next_start:next_end]
  response = POST /act_X/advideos with transfer phase, chunk
  if response.success:
    bytes_uploaded = response.end_offset
  else:
    HANDLE ERROR or RETRY
```

### Phase 3: FINISH

**Request:**
```
POST /v23.0/act_123456/advideos HTTP/1.1

{
  "upload_phase": "finish",
  "upload_session_id": "sess_aabbccdd",
  "video_id": "xyz789"
}
```

**Required params:**
- `upload_phase: "finish"`
- `upload_session_id` (String)
- `video_id` (String)

**Response:**
```json
{
  "video_id": "xyz789",
  "success": true
}
```

**After finish:** Video moves to `processing` state. Encoding is **asynchronous** (~seconds to hours depending on file size).

### Resuming Interrupted Uploads

**Scenario:** Upload interrupted at byte 50MB of 100MB file. How to resume?

**Method 1: Query current offset**
```
GET /v23.0/sess_aabbccdd HTTP/1.1
```
Response:
```json
{
  "upload_session_id": "sess_aabbccdd",
  "file_offset": 52428800
}
```

**Method 2: Resume from returned offset**
```
POST /v23.0/act_123456/advideos
{
  "upload_phase": "transfer",
  "upload_session_id": "sess_aabbccdd",
  "start_offset": 52428800,
  "end_offset": 62914560,
  "video_file_chunk": [bytes 52MB–62MB]
}
```

**Key:** `upload_session_id` remains valid for resume. No expiration documented; assume **24–48 hours** (unconfirmed).

### File Constraints

**Size limits:**
- Resumable upload: up to **1.5 GB**
- Single URL upload (non-chunked): up to **1 GB** (different endpoint)

**Duration:** Up to **45 minutes** (resumable), lower for single-shot

**Aspect ratio:** 16:9 (landscape) to 9:16 (portrait)

**Resolution:**
- Minimum width: 1200 pixels
- Recommended: 1280×720 (16:9)

**Codecs:** H.264, H.265, VP9, AV1 (H.264 most compatible)

**Frame rate:** 24–60 fps

**Chroma subsampling:** 4:2:0

**GOP:** Closed GOP, 2–5 seconds (streaming-friendly)

**Scan:** Progressive (no interlace)

**Audio:**
- Bitrate: 128 kbps minimum (higher for quality)
- Channels: Stereo
- Codec: AAC-LC (Low Complexity)
- Sample rate: 48 kHz

**Formats:** MP4 container (H.264 + AAC) recommended

### Post-Upload: Polling Video Status

**Once finish phase completes, poll for encoding:**

```
GET /v23.0/video_id?fields=status,processing_progress HTTP/1.1
```

**Response:**
```json
{
  "status": "processing",
  "processing_progress": 45,
  "video_status": "in_progress"
}
```

**Status field values:**
- `"ready"` — Encoded, ready for ad creative
- `"processing"` — Still encoding (wait and retry)
- `"error"` — Encoding failed (inspect error details)

**processing_progress:** Integer 0–100 (percent complete during `processing` state)

**Retry strategy:** Poll every 5–10 seconds initially, backoff to 30s if still processing.

---

## 3. NEWER/ALTERNATIVE UPLOAD APIS

### Instagram Resumable Upload API (`/uploads`)

**Does it apply to ad account media library?** **NO.**

The `POST /{APP_ID}/uploads` endpoint is **for Instagram Reels/Stories only**, not for ad account media library. This uses a 2-phase model (Uploading → Processing) with `offset` instead of `start_offset`/`end_offset`.

**Not recommended for ad account media.** Use `advideos` for ad library.

### Deprecation Status (v23.0)

**adimages:** Stable. No deprecation notice.

**advideos:** Stable. No deprecation notice.

**No replacement announced.** Both endpoints current as of v23.0 (May 29, 2025).

---

## 4. ERROR CODES & RATE LIMITING

### Known Error Codes for Media Upload

| Code | Message | Scenario |
|------|---------|----------|
| **3858258** | Image wasn't downloaded | URL-based image unreachable or robots.txt blocked |
| **4** | Application request limit reached | Rate limit at app level |
| **17** | User request limit reached | Rate limit at user/token level |
| **80000** | Unspecified error | Generic upload failure (check logs) |

**No error 2650 found** in v23.0 docs. (2650 historically used for audience-related errors, not media.)

### Rate Limiting Behavior

**Scope:** Ad account level (not per-endpoint)

**Scoring:**
- Read operations: 1 point
- Write operations (POST/PUT): 3 points each

**Limits:**
- Development tier: 60 points max
- Full access tier: 9,000 points max

**When exceeded:**
- Return error code 17 or 613
- Recommend exponential backoff (1s → 2s → 4s → ...)
- Consider batching or upgrading tier

**No specific limits documented for media endpoints.** Apply general rate-limit rules.

---

## 5. MEDIA LIBRARY SEMANTICS

### Is "Ads Media Library" directly backed by adimages/advideos?

**YES.** The Ads Manager media library (visible in UI at Ads Manager → Assets → Media) is exactly the asset store populated by:
- `POST /act_X/adimages` uploads
- `POST /act_X/advideos` uploads

**Not a separate entity.** Same canonical store.

### Listing Media

**Images:**
```
GET /v23.0/act_123456/adimages?fields=hash,url,width,height,name HTTP/1.1
```

**Videos:**
```
GET /v23.0/act_123456/advideos?fields=id,title,description,status HTTP/1.1
```

**Pagination:**
- Use cursor-based pagination: `after` parameter for next page
- Response includes `paging.cursors.after` for continuation

**Useful fields:** hash (images), id/video_id (videos), status, created_time

### Deleting Media

**Images:**
```
DELETE /v23.0/hash HTTP/1.1
```

**Videos:**
```
DELETE /v23.0/video_id HTTP/1.1
```

**Behavior:** Removes asset from media library. References in existing creatives may fail or revert to placeholder. No cascade delete of creatives.

---

## 6. PERMISSION SCOPES

**Required scope:** `ads_management`

- Grants read + write on ad objects (campaigns, ads, media)
- Required for POST, PUT, DELETE on media endpoints

**Read-only alternative:** `ads_read` — Does NOT permit uploads; read-only on metrics/insights

**App Review:** Both scopes require business use explanation + login flow demo

**Additional:** Requesting access tier (Development → Full Access) is separate from scope approval; contact Meta Account Manager for tier upgrade.

---

## TYPESCRIPT SKETCH: Implementation Reference

```typescript
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';

const AD_ACCOUNT_ID = 'act_123456';
const API_VERSION = 'v23.0';
const ACCESS_TOKEN = 'your_access_token';

// ========== IMAGE UPLOAD (single-shot) ==========
async function uploadImage(imagePath: string): Promise<{ hash: string; url: string }> {
  const form = new FormData();
  form.append('image.jpg', fs.createReadStream(imagePath));

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/act_${AD_ACCOUNT_ID}/adimages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      body: form,
    }
  );

  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const data = await response.json();
  return { hash: data.hash, url: data.url };
}

// ========== VIDEO UPLOAD (resumable 4-phase) ==========
interface UploadSession {
  uploadSessionId: string;
  videoId: string;
  fileSize: number;
  uploadedBytes: number;
}

async function startVideoUpload(
  videoPath: string,
  title: string
): Promise<UploadSession> {
  const fileSize = fs.statSync(videoPath).size;

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/act_${AD_ACCOUNT_ID}/advideos`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_phase: 'start',
        file_size: fileSize,
        title,
      }),
    }
  );

  if (!response.ok) throw new Error(`Start phase failed: ${response.status}`);
  const data = await response.json();

  return {
    uploadSessionId: data.upload_session_id,
    videoId: data.video_id,
    fileSize,
    uploadedBytes: 0,
  };
}

async function transferVideoChunk(
  session: UploadSession,
  chunkStart: number,
  chunkEnd: number,
  videoPath: string
): Promise<{ success: boolean; nextEnd: number }> {
  const chunk = Buffer.alloc(chunkEnd - chunkStart);
  const fd = fs.openSync(videoPath, 'r');
  fs.readSync(fd, chunk, 0, chunkEnd - chunkStart, chunkStart);
  fs.closeSync(fd);

  const form = new FormData();
  form.append('upload_phase', 'transfer');
  form.append('upload_session_id', session.uploadSessionId);
  form.append('start_offset', chunkStart.toString());
  form.append('end_offset', chunkEnd.toString());
  form.append('video_file_chunk', chunk, 'chunk.bin');

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/act_${AD_ACCOUNT_ID}/advideos`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      body: form,
    }
  );

  if (!response.ok) throw new Error(`Transfer failed: ${response.status}`);
  const data = await response.json();

  return { success: data.success, nextEnd: data.end_offset };
}

async function finishVideoUpload(session: UploadSession): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/act_${AD_ACCOUNT_ID}/advideos`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_phase: 'finish',
        upload_session_id: session.uploadSessionId,
        video_id: session.videoId,
      }),
    }
  );

  if (!response.ok) throw new Error(`Finish phase failed: ${response.status}`);
}

async function uploadVideoResumable(videoPath: string, title: string): Promise<string> {
  const session = await startVideoUpload(videoPath, title);
  const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

  let offset = 0;
  while (offset < session.fileSize) {
    const chunkEnd = Math.min(offset + CHUNK_SIZE, session.fileSize);
    console.log(`Uploading chunk ${offset}–${chunkEnd}...`);

    const result = await transferVideoChunk(session, offset, chunkEnd, videoPath);
    if (!result.success) {
      throw new Error(`Chunk transfer failed at offset ${offset}`);
    }

    offset = result.nextEnd;
  }

  await finishVideoUpload(session);
  console.log(`Upload complete. Video ID: ${session.videoId}`);

  return session.videoId;
}

// ========== POLLING VIDEO STATUS ==========
async function pollVideoStatus(
  videoId: string,
  maxWait: number = 300_000
): Promise<'ready' | 'processing' | 'error'> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const response = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${videoId}?fields=status,processing_progress`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const data = await response.json();
    console.log(`Status: ${data.status}, Progress: ${data.processing_progress}%`);

    if (data.status === 'ready' || data.status === 'error') {
      return data.status;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000)); // 5s retry
  }

  throw new Error('Video processing timeout');
}

// ========== USAGE ==========
async function main() {
  // Upload image
  const imgResult = await uploadImage('./sample.jpg');
  console.log(`Image uploaded. Hash: ${imgResult.hash}`);

  // Upload video (resumable)
  const videoId = await uploadVideoResumable('./sample.mp4', 'My Ad Video');
  const status = await pollVideoStatus(videoId);
  console.log(`Final status: ${status}`);
}

main().catch(console.error);
```

---

## UNRESOLVED QUESTIONS

1. **Exact image file size limit (v23.0):** Documentation does not specify. Likely 5–10MB based on asset feed examples, but not officially stated. **Action:** Test empirically or contact Meta support.

2. **Upload session expiration time:** No TTL documented for resumable session. Assume 24–48 hours; confirm via support or observe in production.

3. **Chunk size flexibility:** Meta uses 10MB chunks in examples. No explicit maximum documented. Can smaller chunks be used safely? (Likely yes, but not confirmed.)

4. **Image format codec support:** Docs list JPEG, PNG, GIF but no codec specifics (e.g., JPEG 2000, AVIF). Assume baseline JPEG/PNG.

5. **Video processing time SLA:** No SLA given for encoding duration. Ranges from seconds to hours depending on size/codec. No documented backoff strategy.

6. **Ads Manager UI sync delay:** Uploaded media may not appear in Ads Manager UI immediately. Lag time not documented.

---

## SOURCES CITED

- [Graph API Reference v25.0: Ad Image](https://developers.facebook.com/docs/marketing-api/reference/ad-image/)
- [Graph API Reference v25.0: Ad Account Ads](https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/)
- [Marketing API — Video Ads Guide (FB Video Ads)](https://developers.facebook.com/docs/marketing-api/guides/videoads/fbvideoads/)
- [Video API — Publishing Guide](https://developers.facebook.com/docs/video-api/guides/publishing/)
- [Graph API Reference: Video Status](https://developers.facebook.com/docs/graph-api/reference/video-status/)
- [Instagram Platform — Resumable Uploads](https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads/)
- [Marketing API — Rate Limiting](https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/)
- [Marketing API — Error Reference](https://developers.facebook.com/docs/marketing-api/error-reference/)
- [Marketing API — Authorization](https://developers.facebook.com/docs/marketing-api/get-started/authorization/)
- [Marketing API v23.0 Changelog](https://developers.facebook.com/docs/marketing-api/marketing-api-changelog/version23.0/)
- [Graph API v23.0 Changelog](https://developers.facebook.com/docs/graph-api/changelog/version23.0/)
- [Asset Feed Options — Marketing API](https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/options/)

---

**Status:** DONE

**Summary:** Comprehensive specification of Meta Marketing API v23.0 media upload endpoints with exact parameter names, response schemas, resumable protocol phases, and file constraints. Both endpoints are stable; no deprecations in v23.0.

**Concerns:** 3 unresolved edge cases (image size limit, session TTL, chunk flexibility) due to incomplete official documentation—flag for empirical validation during implementation.
