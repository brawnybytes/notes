# YouTube System Design — Complete Interview Reference

---

## Table of Contents

1. [Requirements](#1-requirements)
2. [Capacity Estimation](#2-capacity-estimation)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Video Upload Pipeline](#4-video-upload-pipeline)
5. [Video Streaming Pipeline](#5-video-streaming-pipeline)
6. [Metadata Service](#6-metadata-service)
7. [Search](#7-search)
8. [Recommendations](#8-recommendations)
9. [Live Streaming](#9-live-streaming)
10. [DRM — Digital Rights Management](#10-drm--digital-rights-management)
11. [Monetization and Ad Serving](#11-monetization-and-ad-serving)
12. [Database Choices Summary](#12-database-choices-summary)
13. [FAANG-Level Depth](#13-faang-level-depth)
14. [Security](#14-security)
15. [Observability](#15-observability)
16. [Deployment and Reliability](#16-deployment-and-reliability)
17. [Interview Time Split](#17-interview-time-split)
18. [Key Talking Points Cheatsheet](#18-key-talking-points-cheatsheet)

---

## 1. Requirements

### Start every interview by clarifying these

**Functional requirements**
- User can upload a video
- User can stream / watch a video
- User can search for videos
- User can like, dislike, comment, subscribe
- User gets a recommendation feed (homepage)
- Video view count is tracked

**Non-functional requirements**
- High availability — 99.99% uptime
- Low latency — video starts within 1–2 seconds, no buffering
- Massive scale — 2B logged-in users/month, 500 hours uploaded per minute
- Durability — uploaded video must never be lost
- Eventual consistency is acceptable for counts (views, likes)
- Strong consistency needed for user accounts and payments
- Read-heavy — read:write ratio ~100:1

**Explicitly scope out (unless asked)**
- Live streaming (different architecture)
- DRM / content protection
- Monetization / ad serving

---

## 2. Capacity Estimation

### Storage
- 500 hours of video uploaded per minute
- 1 minute of 1080p ≈ 150 MB
- 500 hours × 60 min × 150 MB = **~4.5 TB/minute** raw
- After transcoding into 5 resolutions ≈ 4× more = **~18 TB/minute**
- Over years → petabytes → need tiered storage

### Bandwidth
- ~1 billion hours of video watched per day
- 1B hours / 86,400 sec = ~11.5M concurrent streams
- Average 720p stream ≈ 2–4 Mbps
- Total outbound ≈ **40–50 Tbps** → massive CDN required

### QPS
- 2B users, 10% active at peak = 200M concurrent
- 5 videos/day each = 1B plays/day → **~11,500 video play requests/sec**
- Search: ~3,800 QPS
- Upload: ~8 upload requests/sec (tiny compared to reads)

---

## 3. High-Level Architecture

Four main subsystems — each scales independently:

```
1. Upload pipeline     → ingest raw video, transcode, store
2. Streaming pipeline  → serve video chunks via CDN
3. Metadata + engagement → video info, likes, views, comments
4. Discovery           → search and recommendations
```

### Architecture diagram

```
┌─────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌─────────┐
│ Client  │────▶│   API Gateway    │────▶│  Load Balancer   │────▶│ Client  │
└─────────┘     │ Auth, rate limit │     │  Routes services │     └─────────┘
                └──────────────────┘     └──────────────────┘

┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│         UPLOAD PIPELINE             │  │         STREAMING PIPELINE           │
│                                     │  │                                      │
│  Upload svc ──▶ Raw S3              │  │  CDN edge ──▶ S3 origin             │
│  (chunked,         │                │  │  (global,       (cache miss only)    │
│  resumable)        ▼                │  │  cached)                             │
│              Kafka queue            │  │                                      │
│                    │                │  │  HLS/DASH player                    │
│                    ▼                │  │  (chunks + adaptive bitrate)         │
│              Transcoder             │  └─────────────────────────────────────┘
│              (FFmpeg, ABR)          │
│                    │                │  ┌─────────────────────────────────────┐
│                    ▼                │  │            DISCOVERY                 │
│              Processed S3 ──▶ Metadata svc    Search svc ──▶ Elasticsearch  │
│              (HLS chunks)    (writes to DB)   (query+rank)   (inverted index)│
└─────────────────────────────────────┘                                        │
                                         Recommend svc ──▶ Redis cache        │
┌─────────────────────────────────────┐  (two-stage ML)    (pre-computed)     │
│      METADATA + ENGAGEMENT          │                                        │
│                                     │  Indexing svc ──▶ ML pipeline         │
│  Metadata svc ──▶ Cassandra         │  (Kafka consumer)  (batch, offline)   │
│  (video info)     (video metadata)  │  └─────────────────────────────────────┘
│                                     │
│  View/like svc ──▶ Redis            │
│  (counts)          (buffer→DB flush)│
│                                     │
│  User svc ──▶ PostgreSQL            │
│  (accounts)   (users, ACID)         │
└─────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                         KAFKA EVENT BUS                                      │
│       Decouples all services: upload, transcode, index, notify, reco         │
└──────────────────────────────────────────────────────────────────────────────┘

Color legend:
  [Teal]   = Upload pipeline
  [Blue]   = Streaming pipeline
  [Coral]  = Metadata + engagement
  [Amber]  = Discovery
  [Gray]   = Client / shared infra
```

---

## 4. Video Upload Pipeline

### Full flow step by step

**Step 1 — Chunked upload from client**
- Client splits file into 5 MB chunks, uploads sequentially or in parallel
- Why: resumable uploads — if connection drops at chunk 38, resume from chunk 38
- Client talks to Upload Service via HTTPS
- Upload progress tracked in Redis (chunk offsets per upload_id)

**Step 2 — Upload Service**
- Stateless API server
- Authenticates user (validates JWT)
- Accepts chunks, writes to raw S3 bucket
- On all chunks received: publishes message to Kafka
- Returns "upload successful, processing" to user immediately
- Does NOT transcode — decoupled via queue

**Step 3 — Kafka message**
```json
{
  "video_id": "abc123",
  "user_id": "user_456",
  "raw_s3_path": "s3://raw-videos/abc123.mp4",
  "title": "My vacation video",
  "uploaded_at": "2024-01-15T10:30:00Z"
}
```
- Kafka guarantees message is not lost even if transcoding service crashes
- On restart, consumer re-reads from last committed offset

**Step 4 — Transcoding Service**
- Most CPU-heavy component
- Downloads raw video from S3
- Spawns parallel jobs per resolution: 360p, 720p, 1080p, 4K
- Uses FFmpeg under the hood
- Splits each resolution into 2–10 second chunks (segments)
- Generates manifest file (.m3u8 for HLS or .mpd for DASH)
- Uploads all chunks + manifest to processed S3 bucket
- Publishes completion event to Kafka

**Why multiple resolutions?**
- User on fast WiFi → 1080p
- User on 3G → 360p
- Player switches automatically based on bandwidth → Adaptive Bitrate (ABR)

**Step 5 — Metadata Service**
- Consumes transcoding completion event
- Writes to database:
```
video_id, title, user_id, status=PUBLISHED,
resolutions=[360p,720p,1080p], duration,
thumbnail_url, manifest_url, created_at
```
- Video is now discoverable

### Why Kafka instead of direct call?
- Transcoding takes minutes — you can't block the upload API
- Decoupling means each service scales independently
- If transcoding crashes, messages queue up safely, processed on restart
- Horizontal scaling: spike in uploads → spin up more transcoding workers

---

## 5. Video Streaming Pipeline

### Full flow step by step

**Step 1 — Client requests manifest**
- `GET https://cdn.youtube.com/abc123/manifest.m3u8`
- Hits CDN edge node (nearest to user) first
- Cache hit → returns immediately
- Cache miss → CDN fetches from S3 (origin), caches, returns

**Step 2 — Manifest file (HLS example)**
```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
1080p/index.m3u8
```
- Lists available quality levels and bandwidth requirements
- Player picks one based on current network conditions

**Step 3 — Player downloads chunks**
- Downloads chunk_000.ts, plays it while downloading chunk_001.ts, etc.
- Constantly measures download speed
- Switches resolution up/down automatically = **Adaptive Bitrate (ABR)**
- User never talks directly to storage — always through CDN

### Why CDN is critical
- Without CDN: 11M concurrent streams × 1 chunk/6sec = ~2M requests/sec to origin — impossible
- With CDN: popular chunks cached at hundreds of edge nodes, 95%+ cache hit rate
- Only 5% of requests reach origin — manageable

### Hot/new videos
- First viewers cause cache misses → CDN fetches from S3 → caches
- After that, millions of viewers served from CDN cache
- This is called **cache warming**
- Viral videos handled naturally — CDN is distributed, no single server overwhelmed

---

## 6. Metadata Service

### View count problem — classic interview question

**Naive approach (wrong):**
```sql
UPDATE videos SET view_count = view_count + 1 WHERE video_id = 'abc123'
```
Problem: viral video = 100,000 writes/sec to same row → DB dies

**Correct approach — Redis buffer + periodic flush:**
- Every view: `INCR view_count:abc123` in Redis (atomic, microseconds, 1M ops/sec)
- Background job every 30–60 seconds: read Redis counter → add to DB value → reset Redis
- DB gets 1 write per 30 sec per video instead of 100,000/sec
- Count is max 60 seconds stale — completely acceptable

Same pattern for likes/dislikes.

### Watch history
- Write to Kafka topic on meaningful watch events (>30 sec watched, completed)
- Consumer persists to Cassandra
- Also feeds recommendations pipeline

### Database choices
| Data | DB | Why |
|---|---|---|
| Video metadata | Cassandra | High write scale, no complex joins |
| User accounts | PostgreSQL | ACID, relational, joins needed |
| View/like counts | Redis → DB flush | Atomic increments, eventual consistency |
| Watch history | Cassandra | Append-heavy, massive volume |

---

## 7. Search

### Why not SQL LIKE?
`SELECT * FROM videos WHERE title LIKE '%cats piano%'` → full table scan on 800M videos → unusable

### Elasticsearch
- Built on Apache Lucene
- Uses **inverted index**: word → list of documents containing it
- Query "cats playing piano" → intersect posting lists → results in milliseconds

**Inverted index example:**
```
"cat"    → [video_1, video_5, video_9]
"piano"  → [video_2, video_5, video_11]
"playing"→ [video_1, video_3, video_5]
```
video_5 appears in all three → highest relevance

### Indexing pipeline
- Video published → event on Kafka
- Indexing Service consumes → fetches metadata → writes to Elasticsearch
- Fields indexed: video_id, title, description, tags, channel_name, uploaded_at, view_count

### Two-stage ranking
1. Elasticsearch returns top 1,000 candidates (text relevance score)
2. ML ranking model re-ranks top 1,000 using:
   - View count
   - Upload recency
   - Watch time (completion rate)
   - Channel authority
   - User personalization (subscribed channels rank higher)
3. Return top 20 results

---

## 8. Recommendations

### The problem
800M videos × 2B users — can't compute every pair. Need smart shortcuts.

### Two-stage architecture

**Stage 1 — Candidate generation (narrow to ~hundreds)**
- **Collaborative filtering**: users similar to you watched X, Y, Z
- **Content-based**: you watched 10 cooking videos → more cooking videos
- **Matrix factorization / embeddings**: represent users and videos as vectors in latent space. Find nearest video vectors to user vector using FAISS or ScaNN.
- Returns ~hundreds of candidates per user in milliseconds

**Stage 2 — Ranking (score each candidate)**
Features fed into ranking neural network:
- Watch time on similar videos (strongest signal)
- Click-through rate for this user segment
- Video freshness
- User's last hour activity
- Whether user has seen this video before

Output: score per candidate → sort → return top 20

### Serving
- Full pipeline runs **offline** (batch, periodic)
- Pre-computed recommendations stored in Redis: `recommendations:user_456`
- Homepage load → `GET recommendations:user_456` → instant
- Refreshed every few hours or triggered by watch events

---

## 9. Live Streaming

### How it differs from regular video
| | Regular Video | Live Streaming |
|---|---|---|
| Latency | Not important | Critical (5–30 sec) |
| Transcoding | Batch, offline | Real-time, simultaneous |
| Ingest protocol | HTTPS upload | RTMP push |
| Chunks | All at once | Rolling, continuous |
| CDN caching | High cache hit rate | Near zero — chunks always new |

### Pipeline

**Step 1 — Broadcaster encodes locally**
- OBS / encoder captures camera + audio
- Encodes in real-time: H.264 or H.265
- Produces continuous stream of data

**Step 2 — Push via RTMP**
- RTMP (Real-Time Messaging Protocol) — low-latency TCP-based protocol
- Broadcaster gets RTMP ingest URL + stream key
- Connects to nearest ingest server (YouTube has regional ingest servers)

**Step 3 — Transmuxing + transcoding**
- **Transmuxing**: repackage RTMP → HLS/DASH format (fast, no re-encoding)
- **Transcoding**: simultaneously convert to multiple resolutions
- Lower resolutions available first (transcoding 4K takes longer)
- Runs on dedicated real-time transcoding servers (not batch workers)

**Step 4 — Live segments to CDN**
- Each 2–4 sec chunk produced → immediately pushed to CDN
- Manifest file continuously updated with new segments
- Viewer's player fetches manifest every few seconds → sees new segments → downloads
- End-to-end latency: ~5–30 seconds (Low-Latency HLS / LL-HLS)

**Step 5 — Live chat**
- Separate WebSocket-based system
- Viewers connect via WebSocket
- Messages broadcast to all connected clients (pub/sub)
- Concurrent viewer count in Redis (INCR on join, DECR on leave)

**Step 6 — Recording**
- All segments saved as they're produced
- On stream end → segments assembled into VOD
- Goes through lightweight post-processing → becomes watchable video

### CDN challenge for live
- Regular video: chunks are static → high cache hit rate
- Live chunks: brand new every 2–4 seconds → near-zero cache benefit
- Solution: **origin shielding** — only a few CDN mid-tier nodes hit origin, edge nodes fetch from mid-tier

---

## 10. DRM — Digital Rights Management

### What problem it solves
Without DRM: user downloads chunks (just .ts files on CDN URLs), concatenates, has full movie.
Studios won't license content without DRM.

### How it works

**Encryption at transcoding time:**
- Generate Content Encryption Key (CEK) — random AES-128/256 key
- Encrypt every video chunk with CEK
- CEK encrypted with Key Encryption Key (KEK) managed by license server
- Encrypted chunks go to CDN — useless without the key

**Playback flow:**
1. Player downloads manifest, sees DRM required
2. Player identifies DRM system: Widevine (Chrome/Android), FairPlay (Safari/iOS), PlayReady (Edge/Windows)
3. Player contacts License Server with: user auth token + DRM challenge
4. License Server verifies: user allowed to watch? (paid, right region, not blocked device?)
5. If yes → returns decryption key, encrypted for that specific device's DRM module
6. DRM module decrypts key inside **Trusted Execution Environment (TEE)** — hardware-isolated, OS can't inspect
7. Video decrypted chunk by chunk inside TEE → rendered to screen
8. Raw decrypted frames never exposed to application layer

### Why TEE matters
Without hardware protection → malicious app could intercept decrypted video in memory.
TEE ensures decryption in hardware-isolated area — even compromised OS can't extract raw video.

### Key server design
- Stateless API (horizontally scalable)
- Every license request logged (audit trail for studios)
- Rate limiting per user (prevent key farming)
- License duration — key expires after X hours, player must re-request
- Keys stored in **HSM (Hardware Security Module)** — tamper-proof, even employees can't read in plaintext

---

## 11. Monetization and Ad Serving

### Ad types
- Pre-roll: before video, skippable after 5 sec or non-skippable (15 sec)
- Mid-roll: inserted at chapter breaks (videos >8 min)
- Overlay: banner over video
- Bumper ads: 6-sec non-skippable

### Ad serving pipeline

**Step 1 — Ad request**
When player is about to play (or hit mid-roll), sends request to Ad Decision Server (ADS):
- Video ID being watched
- User ID / anonymized profile
- Location, device type
- Targeting signals: age, interests, watch history
- Ad slot: pre-roll vs mid-roll, max duration, skippable or not

**Step 2 — Real-Time Bidding (RTB) auction**
- ADS triggers auction — must complete in <100ms
- Advertisers pre-set campaigns with targeting criteria and bid amounts
- ADS broadcasts to Demand Side Platforms (DSPs) representing advertisers
- DSPs decide whether to bid and at what price
- All bids return within ~80ms

**Step 3 — Ad selection**
- **Second-price auction** (Vickrey): winner pays second-highest bid + $0.01
- Encourages honest bidding
- Also considers ad quality score (not just price) → protects UX

**Step 4 — Ad delivery**
- Winning ad URL returned to player
- Player fetches ad from ad server's CDN
- Ad plays → main video starts

**Step 5 — Tracking**
- Impression fires when ad plays
- Skip events, click-through logged
- Goes to Kafka → BigQuery (data warehouse) for billing and reporting
- Billing: CPM (per 1,000 impressions), CPV (per view = 30 sec watched), CPC (per click)

### Revenue split
YouTube keeps ~45%, creator gets ~55%. Computed in batch, 1–2 day delay.

### Key insight: recommendations and monetization are linked
- Algorithm optimizes for **watch time** → more watch time → more mid-rolls → more revenue
- This is why autoplay exists, why longer videos are favored, why thumbnails are click-optimized

### Ad server design requirements
- <100ms end-to-end for entire auction
- Highly available — if ADS goes down, serve video without ads (don't block playback)
- Fraud detection: ML model detects click fraud (bots) asynchronously

---

## 12. Database Choices Summary

| What | DB | Why |
|---|---|---|
| Video metadata | Cassandra | High write scale, wide rows, no complex joins |
| User accounts | PostgreSQL | ACID, relational, strong consistency |
| View / like counts | Redis → Cassandra flush | Atomic increments, 1M ops/sec, eventual consistency |
| Watch history | Cassandra | Append-heavy, bucket by month |
| Search index | Elasticsearch | Inverted index, full-text, ranked results |
| Recommendations cache | Redis | Sub-millisecond reads |
| Raw video files | S3 / GCS | Blob storage, cheap at petabyte scale |
| Processed chunks | S3 + CDN | Cheap origin + global edge serving |
| Subscriptions | Cassandra (two tables) | Query by user AND by channel |
| Live chat | Redis pub/sub | Real-time fan-out |

---

## 13. FAANG-Level Depth

### Cassandra data modeling

**Rule: design schema query-first. Partition key determines data distribution and query speed.**

**Video metadata table**
```sql
CREATE TABLE videos (
    video_id      UUID,
    user_id       UUID,
    title         TEXT,
    description   TEXT,
    tags          LIST<TEXT>,
    duration      INT,
    status        TEXT,
    manifest_url  TEXT,
    thumbnail_url TEXT,
    created_at    TIMESTAMP,
    PRIMARY KEY (video_id)
);
```
Partition key: `video_id` — high cardinality, even distribution, O(1) lookup.

**Watch history table (bucketed)**
```sql
CREATE TABLE watch_history (
    user_id    UUID,
    bucket     TEXT,         -- "2024-01" (year-month)
    watched_at TIMESTAMP,
    video_id   UUID,
    watch_pct  INT,
    PRIMARY KEY ((user_id, bucket), watched_at)
) WITH CLUSTERING ORDER BY (watched_at DESC);
```
Why bucketed: unbucketed partition grows unboundedly for heavy users. Monthly bucket caps partition size.
Clustering key `watched_at DESC`: rows physically sorted newest-first → `LIMIT 50` returns latest 50 instantly.

**Subscriptions (two tables — one per query)**
```sql
CREATE TABLE subscriptions_by_user (
    user_id    UUID,
    channel_id UUID,
    subscribed_at TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE subscriptions_by_channel (
    channel_id UUID,
    user_id    UUID,
    subscribed_at TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
);
```
Write to both on subscribe/unsubscribe. Dual write — handle partial failure with idempotency or reconciliation.

---

### Idempotency and exactly-once delivery

**The problem:** Kafka delivers at-least-once. Consumer crashes after processing but before committing offset → re-reads same message → processes twice.

**Solution: make every consumer idempotent**

Transcoding Service:
- Before starting: check if `s3://processed/abc123_720p/` exists → if yes, skip
- S3 object writes are atomic — safe check-then-act

Metadata Service:
- Use `INSERT IF NOT EXISTS` (Cassandra lightweight transaction)
- Duplicate message → record already exists → no-op

Notification Service:
- `SETNX notification:abc123 1` in Redis (with TTL)
- Returns 0 → already sent → skip
- Returns 1 → send → proceed

**True end-to-end exactly-once:** design for at-least-once + idempotent consumers. This is what every major company actually does. Kafka EOS (exactly-once semantics) only covers producer-to-broker, not consumer-to-external-system.

---

### Distributed transactions

**Problem scenario:**
Transcoding completes. Need to:
1. Write chunks to S3
2. Write metadata to Cassandra
3. Publish event to Kafka

Can't use ACID across three different systems. What if step 2 succeeds but step 3 fails?

**Solution 1 — Outbox pattern**
```sql
BEGIN TRANSACTION;
  INSERT INTO videos (...) VALUES (...);
  INSERT INTO outbox (event_id, event_type, payload, created_at)
    VALUES (uuid(), 'VIDEO_PUBLISHED', '{"video_id":"abc123"}', now());
COMMIT;
```
- Metadata write + event write are atomic (same local DB transaction)
- Separate outbox poller reads unpublished events → publishes to Kafka → marks as published
- Guarantees at-least-once publishing
- Consumer handles duplicates via idempotency

**Solution 2 — Saga pattern**
- Sequence of local transactions, each publishing an event triggering the next
- Failure triggers compensating transactions

```
TranscodeVideo → success → PublishMetadata → success → IndexInElasticsearch
                                           → fail    → MarkVideoAsFailed (compensate)
```
- No distributed lock, no 2PC
- YouTube's pipeline is effectively a saga

---

### Rate limiting

**Why:** prevent upload spam, scraping, brute force, transcoding queue explosion.

**Token bucket algorithm (recommended)**
- Each user gets bucket with N tokens, refills at fixed rate (e.g., 10/sec)
- Each request costs 1 token
- Empty bucket → HTTP 429 Too Many Requests
- Allows short bursts (full bucket), smooths sustained overload
- State stored in Redis: `INCR` + `EXPIRE`

**Other algorithms:**
- **Leaky bucket**: fixed output rate regardless of input bursts — good for protecting downstream
- **Fixed window counter**: simple but edge case at window boundary (2x limit possible)
- **Sliding window counter**: hybrid — most practical for production

**Distributed rate limiting:**
- 100 API gateway instances can't each maintain local counters
- All instances check same Redis key per user
- Redis atomic `INCR` + `EXPIRE` makes this safe and fast

**YouTube-specific limits:**
- Upload: 10 uploads/user/hour
- Search: 100 requests/user/minute
- Comment: 10 comments/user/minute
- Video play: generous (1000/min) but IP-rate-limit against scrapers

---

### Hot shard / hot partition

**Problem:** MrBeast uploads a video → millions of reads hit same Cassandra partition (video_id = X) → one node overloaded while others idle.

**Solution 1 — Cache (best for read-heavy)**
- Cache hot video metadata in Redis with short TTL
- First request misses → hits Cassandra → caches in Redis
- Millions of subsequent requests → Redis only
- One Cassandra node handles cache warming, Redis handles the storm

**Solution 2 — Write sharding (for write-heavy)**
- Instead of one row: create N rows with shard suffix
```
like_count:abc123_shard_0
like_count:abc123_shard_1
...
like_count:abc123_shard_9
```
- Distribute writes across 10 shards → 10 different Cassandra nodes
- To read total: sum all 10 shards
- Trade-off: writes 10x cheaper, reads 10x more expensive

**Solution 3 — Cassandra vnodes**
- Each physical node handles many small token ranges (virtual nodes)
- Better load distribution naturally
- Easier rebalancing when adding nodes

---

### Geo-replication

**Problem:** DB in US-East. User in Mumbai reads metadata → ~200ms round-trip before any processing. Unacceptable.

**Active-passive replication**
- One primary region (writes go here)
- Read replicas in other regions (serve local reads)
- Async replication: primary → replicas
- Writes still go to primary (slow for non-US users, but writes are rare)
- Replication lag: replicas slightly behind → eventual consistency across regions
- Acceptable for YouTube (stale like count is fine)

**Active-active replication**
- Every region accepts reads AND writes
- Pros: writes also low-latency globally
- Cons: conflict resolution needed

Conflict resolution strategies:
- **Last Write Wins (LWW)**: most recent timestamp wins — simple, can lose data
- **CRDTs**: data structures that merge automatically (view count CRDT always gives correct sum)
- **Application-level**: user resolves conflict — not viable at scale

**Cassandra multi-region:**
- `LOCAL_QUORUM`: quorum in local datacenter only → fast local ops, async cross-region
- `EACH_QUORUM`: quorum in every DC → strong global consistency but high latency
- YouTube uses `LOCAL_QUORUM` — eventual consistency across regions is fine

**CDN as geo-replication for video:**
- Video files don't need explicit multi-region S3 replication
- CDN edge nodes pull from origin on first request, cache regionally
- CDN IS your geo-replication layer for video content

---

### Cost optimization

**Lazy / on-demand transcoding**
- On upload: immediately transcode to 360p + 720p only (fast, covers most users)
- When user requests 1080p: check if exists in S3 → if not, transcode on demand → serve 720p meanwhile
- 4K: same — generate on demand, cache result
- 90% of videos rarely watched → huge savings on CPU

**Storage tiering**
| Tier | Storage | When | Cost |
|---|---|---|---|
| Hot | S3 Standard (SSD) | Last 30 days, high view count | ~$0.023/GB/month |
| Warm | S3 Infrequent Access | 1–12 months, moderate views | ~$0.0125/GB/month |
| Cold | S3 Glacier | Not watched in 1+ year | ~$0.004/GB/month |

Lifecycle policies move videos between tiers automatically. 6x cost savings for cold content.

**Deduplication**
- Compute SHA-256 or perceptual hash of video on upload
- If hash exists in storage → don't store second copy → new metadata record points to existing file
- Also how Content ID copyright detection works

**Codec optimization**
- H.264: baseline, widely supported
- VP9: ~50% better compression than H.264 (YouTube default on Chrome)
- AV1: ~30% better than VP9, open source (YouTube actively migrating)
- Migrating library to AV1 saves massive storage + bandwidth

---

### Failure scenarios

**Transcoding service crashes mid-transcode:**
- Kafka message never acknowledged → on restart, re-reads → re-transcodes
- Raw video safe in S3 — idempotent, just overwrites output
- No data loss

**CDN edge node goes down:**
- CDN has built-in redundancy → fail over to next nearest edge
- Client retries automatically → brief buffer at worst

**Metadata DB goes down:**
- Video playback still works — chunks served from CDN, no DB needed
- Search degraded, new uploads fail
- Health checks detect → fail over to replica

**Viral video floods origin:**
- CDN absorbs it — first 1,000 viewers miss cache, hit origin
- After that, millions of viewers hit CDN cache
- Origin sees ~1,000 req/sec regardless of virality

**Redis goes down (view counts):**
- Unflushed counts lost — slight undercount
- Acceptable — eventual consistency
- Mitigate: Redis AOF persistence, Redis Cluster for HA

---

## 14. Security

### Transport Security
- All traffic TLS 1.2/1.3
- TLS terminated at CDN edge (for video) and API Gateway (for API)
- Internal services: mTLS (mutual auth between services) or plaintext on trusted VPC
- TLS 1.3: 1 round-trip handshake (vs 2 for 1.2), supports 0-RTT resumption
- Certificate pinning in mobile apps — rejects certs not matching expected fingerprint

### Authentication

**JWT structure:**
```
Header.Payload.Signature
{ "alg": "RS256" } . { "user_id": "abc", "exp": 1700000900 } . RSASHA256(...)
```
- API Gateway verifies signature with public key — no DB lookup needed
- Access token: **15-minute expiry** — short because JWTs are stateless, can't revoke early
- Refresh token: 30-day expiry, stored in HTTP-only cookie + DB

**Refresh token rotation:**
- Every use of refresh token → issue new one, invalidate old
- Same refresh token used twice → detect reuse → invalidate all tokens for user → force re-login

**OAuth 2.0 for third-party apps:**
- User grants specific scopes (youtube.upload, youtube.readonly)
- App gets scoped access token
- User can revoke anytime

### Authorization

**RBAC:**
- Roles: viewer, creator, moderator, admin
- Permissions assigned to roles
- Check: role permits action AND user owns the resource

**Principle of least privilege:**
- Transcoding Service: read raw S3 + write processed S3 + publish Kafka only
- No service has blanket access to everything
- Compromised service → limited blast radius

### Data Security

**Encryption at rest:**
- S3: AES-256 server-side encryption by default
- Keys managed by AWS KMS — application never sees raw key
- DB: filesystem-level encryption (dm-crypt/LUKS)

**Key management:**
- Keys stored in HSM or managed KMS (AWS KMS, HashiCorp Vault)
- Keys never exist in plaintext outside HSM
- Regular key rotation + re-encryption of data

**Data classification:**
| Level | Examples | Protection |
|---|---|---|
| Public | Video chunks, thumbnails | No special protection |
| Internal | View counts, analytics | Moderate |
| Confidential | Email, watch history, search history | Strong, restricted access |
| Restricted | Payment info, gov IDs | Highest, PCI-DSS/GDPR, full audit |

**GDPR / data deletion:**
- User requests deletion → "delete user X" event on Kafka → every service deletes their copy
- Backups problem: can't delete from backup files
- **Crypto-shredding**: encrypt user data with per-user key → delete the key → backup data becomes unreadable

### Application Security

**SQL/NoSQL Injection — always use prepared statements:**
```java
// WRONG
String query = "SELECT * FROM videos WHERE title = '" + userInput + "'";

// CORRECT
PreparedStatement stmt = session.prepare("SELECT * FROM videos WHERE title = ?");
stmt.bind(userInput);
```

**XSS prevention:**
- Output encode all user content (`<` → `&lt;`)
- Content Security Policy header: `Content-Security-Policy: script-src 'self'`
- HTTP-only cookies: session cookies can't be read by JS even if XSS runs

**CSRF prevention:**
- CSRF tokens: server-issued token in cookie + hidden form field, must match on submit
- `SameSite=Strict` cookie attribute: browser won't send cookie on cross-site requests

**SSRF prevention (user-submitted URLs for thumbnails etc.):**
- Whitelist URL schemes (https only)
- Resolve URL to IP, reject private ranges: 10.x, 172.16.x, 192.168.x, 169.254.x (AWS metadata)
- Use dedicated egress proxy for outbound requests

**Presigned upload URLs:**
- Client requests upload URL from Upload Service
- Upload Service generates temporary presigned S3 URL (valid 1 hour, PUT only, specific key, max size)
- Client uploads directly to S3 — your servers see zero bytes of video data
- S3 verifies cryptographic signature

**Signed CDN URLs for streaming:**
- Video chunks not publicly accessible at static URLs
- Player requests → backend generates signed URL (expires in 1 hour, optionally IP-locked)
- CDN verifies signature before serving

**FFmpeg sandboxing:**
- Run in Docker container with seccomp profiles
- No network access, read-only filesystem except I/O paths
- Non-root user
- Validate file headers before feeding to FFmpeg

### Infrastructure Security

**Network segmentation (VPC subnets):**
```
Public subnet:   Load balancer / API Gateway only (has public IP)
Private subnet:  Application servers (no public IP, reachable from public subnet only)
DB subnet:       Cassandra, PostgreSQL, Redis (no internet access, reachable from private subnet only)
```

**No direct SSH to production:**
- Use bastion host (jump box) with MFA + full session logging
- Better: AWS Systems Manager Session Manager — no open ports, browser-based, fully audited

**Secrets management:**
- Never hardcode secrets or commit to git
- Use HashiCorp Vault or AWS Secrets Manager
- Application fetches secrets at startup
- Access controlled by IAM roles — service only reads secrets it needs
- Regular secret rotation

**Container security:**
- Don't run as root (`USER nonroot` in Dockerfile)
- Read-only filesystem where possible
- Scan images for CVEs (Trivy, Snyk)
- Minimal base images (alpine, distroless)
- Kubernetes NetworkPolicies: restrict which pods can talk to which

### Abuse Prevention

**Content moderation:**
- **Perceptual hashing**: compute hash of video frames → compare against NCMEC CSAM database → match = block + report
- **Content ID**: rights holders submit reference files → fingerprint matching → match = apply rights holder policy
- **ML classifiers**: detect violence, nudity, hate speech → high confidence = auto-remove, medium = human review queue

**Fake view detection:**
- View only counts after 30+ seconds
- Same user_id watching same video 1,000 times → count only first few
- IP-based deduplication
- Behavioral fingerprinting (real users have irregular mouse/scroll patterns, bots are perfectly regular)
- Views go through validation pipeline before incrementing count — why counts sometimes freeze/jump

**Account security:**
- Impossible login detection (India login → Russia login 10 min later → block)
- Login velocity monitoring (1,000 attempts from same IP → credential stuffing → block)
- HIBP integration — check password against breach databases on login/change
- MFA for high-risk accounts (large channels, monetized creators)

**Comment spam:**
- Rate limiting (5 comments/minute/account)
- NLP classifier for spam patterns
- New account comment restrictions
- Shadowbanning (spam hidden from others, poster still sees it)

---

## 15. Observability

### Three pillars

**Metrics — numerical measurements over time**

Key metrics for YouTube:
- Upload success rate, upload latency (p50, p95, p99)
- Transcoding queue depth, processing time per resolution
- CDN cache hit rate per region
- **Video play start time** (time from click to first frame) — most important UX metric
- **Buffering ratio** (% of playback time spent buffering)
- API error rates per endpoint
- DB query latency per service
- Kafka consumer lag (are consumers keeping up with producers?)

Tools: Prometheus (collection) + Grafana (dashboards)

**Logs — structured event records**
```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "service": "transcoding-service",
  "level": "ERROR",
  "video_id": "abc123",
  "message": "FFmpeg exited with code 1",
  "resolution": "1080p",
  "duration_ms": 45231,
  "trace_id": "xyz789"
}
```
- `trace_id` links all log entries across services for one request
- Aggregated in Elasticsearch or Datadog/Splunk

**Traces — end-to-end request flow across services**
- User clicks play → API Gateway → Metadata Service → CDN redirect
- Each hop = a "span", all spans share `trace_id`
- Visualize full path, see where latency is coming from
- Tools: Jaeger, Zipkin, Google Cloud Trace (via OpenTelemetry)

### Alerting
- CDN cache hit rate drops below 85% → alert
- Transcoding queue depth > 10,000 jobs → alert
- Video play error rate > 0.1% → alert
- p99 API latency > 2 seconds → alert

### SLOs (Service Level Objectives)
- 99.9% of video play requests succeed (~8.7 hours downtime/year allowed)
- p95 video start time under 2 seconds
- 99.9% of uploads transcoded within 30 minutes

**Error budget**: if 50% of monthly error budget consumed in week 1 → stop feature work → focus on reliability.

---

## 16. Deployment and Reliability

### Deployment strategies

**Blue-green deployment:**
- Two identical production environments (blue = current, green = new)
- Deploy to green while blue serves traffic
- Switch all traffic to green
- Something breaks → switch back to blue instantly
- Cost: double the infrastructure

**Canary deployment (what YouTube actually uses):**
- Gradually shift traffic to new version: 1% → 5% → 25% → 100%
- Monitor error rates at each stage
- Error spike → automatic rollback
- No need for double infrastructure

**Feature flags:**
- Deploy code but control activation via flag
- New recommendation algorithm deployed to 100% of servers but active for only 1% of users
- Instant rollback without redeployment
- Enables A/B testing

### Reliability patterns

**Circuit breaker:**
- Problem: Metadata Service is slow → video play requests pile up → thread pool exhausts → API Gateway crashes → cascading failure
- Solution: after 50% of calls to Metadata Service fail in 10 seconds → circuit "opens" → calls return immediately with cached response or degraded response → service recovers → circuit "closes"
- Prevents cascading failures

**Bulkhead:**
- Isolate failures — separate thread pools for different downstream services
- If Recommendation Service thread pool exhausts → doesn't affect Metadata Service thread pool
- Named after ship compartments — one compartment floods, others stay dry

**Retry with exponential backoff:**
- Failed request → wait 1s → retry → wait 2s → retry → wait 4s → retry → give up
- Add jitter (random delay) to prevent thundering herd (all clients retrying simultaneously)

**Chaos engineering:**
- Intentionally inject failures in production (kill random pods, add network latency, corrupt messages)
- Ensures system actually handles failures gracefully, not just theoretically
- Netflix's Chaos Monkey is the famous example

---

## 17. Interview Time Split

### 45-minute interview

| Time | Topic |
|---|---|
| 0–3 min | Clarify requirements, confirm scope |
| 3–10 min | Capacity estimation, non-functional requirements |
| 10–20 min | Upload pipeline in detail |
| 20–30 min | Streaming pipeline + CDN + ABR |
| 30–38 min | Metadata DB choices + view count scaling + search |
| 38–43 min | Recommendations (two-stage, embeddings, pre-computed) |
| 43–45 min | Trade-offs, failure scenarios, what you'd improve |

### If interviewer asks to go deeper
- Data modeling → Cassandra schema, partition key design
- Scaling → hot shard problem, Redis buffering, write sharding
- Reliability → circuit breaker, idempotency, outbox pattern
- Security → presigned URLs, JWT rotation, GDPR crypto-shredding
- Ops → SLOs, canary deployment, chaos engineering

---

## 18. Key Talking Points Cheatsheet

These are the sentences that signal senior-level thinking. Drop them naturally.

**On upload:**
> "I'd use chunked resumable uploads — client splits the file into 5MB chunks so if the connection drops, we resume from the last successful chunk rather than starting over."

> "Transcoding is decoupled from the upload API via Kafka. The upload returns immediately, transcoding happens asynchronously. This way we can scale transcoding workers independently."

**On streaming:**
> "The player never downloads the whole video. It uses HLS — the video is split into 2–10 second chunks. The player downloads chunk by chunk while playing, and switches resolution based on available bandwidth. This is adaptive bitrate."

> "CDN is the most critical component for streaming. Without it, 11 million concurrent streams would destroy our origin servers. With CDN, we get 95%+ cache hit rate on popular content — origin barely sees any traffic."

**On view counts:**
> "We can't write to Cassandra on every view — a viral video would get 100,000 writes per second to the same partition. Instead, we buffer in Redis using atomic INCR, then flush to the DB every 30–60 seconds. The count is slightly stale but that's acceptable."

**On search:**
> "SQL LIKE queries are a full table scan on 800 million videos — unusable. Elasticsearch with an inverted index returns ranked results in milliseconds. We do two-stage ranking: Elasticsearch for the first 1,000 candidates, then an ML model re-ranks based on watch time, recency, and personalization."

**On recommendations:**
> "Recommendations are pre-computed offline using a two-stage pipeline. Candidate generation narrows 800 million videos to a few hundred using collaborative filtering and embeddings. A ranking model then scores each candidate for the specific user. Results are cached in Redis per user — homepage load is just a Redis GET."

**On consistency:**
> "I'd use eventual consistency for view counts, like counts, and recommendations — a slightly stale number is fine. But user accounts and subscription data need strong consistency — I'd use LOCAL_QUORUM in Cassandra for those."

**On failures:**
> "Every heavy operation is decoupled via Kafka. If the transcoding service crashes, messages queue up safely. When it restarts, it reads from the last committed offset and picks up where it left off. All consumers are idempotent — processing the same message twice has the same effect as once."

**On security:**
> "For uploads, I'd use presigned S3 URLs — the client uploads directly to S3, our servers never touch the video bytes. For streaming, signed CDN URLs that expire in an hour prevent unauthorized downloading."

> "For GDPR data deletion, the hard part is backups. I'd use crypto-shredding — encrypt user data with a per-user key, store the key separately. To 'delete' from backups, delete the key. The backup data becomes unreadable without it."

**On cost:**
> "Not every video needs 4K immediately. I'd use lazy transcoding — generate 360p and 720p on upload, then 1080p and 4K on first request for that resolution. 90% of videos never get watched enough to justify the CPU cost upfront."

> "For storage, lifecycle policies automatically move videos to cheaper tiers — S3 Infrequent Access after 30 days, Glacier after a year of no views. Glacier is 6x cheaper than standard S3. At petabyte scale this saves significant money."

---

*This document covers the complete YouTube system design as discussed — upload pipeline, streaming, metadata, search, recommendations, live streaming, DRM, monetization, security, observability, and deployment. Sufficient for Senior Engineer interviews at any company including FAANG.*
