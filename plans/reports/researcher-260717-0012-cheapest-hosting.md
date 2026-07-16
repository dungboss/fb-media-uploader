# Research: Cheapest Hosting for Small Next.js App (2026)

## Executive Summary

For your workload (2 users, 1-2x/week use, bursty 50GB/month bandwidth), **Contabo VPS at €5.50/mo with unlimited traffic** wins on pure cost. Oracle Cloud Always Free wins if you can tolerate capacity constraints. Render + Upstash free tier works if you stay under quotas but adds operational complexity.

---

## 1. Single VPS Providers (All Services on One Box)

### Contabo — CHEAPEST with Unlimited Bandwidth
- **Plan**: Cloud VPS 4 (4 vCPU / 8GB RAM / 100GB SSD)
- **Price**: €5.50/mo (first 24mo promo), then renewal rate TBD [UNVERIFIED renewal cost]
- **Bandwidth**: "Unlimited" with fair-use policy (no explicit cap)
- **Regions**: 9 regions including **Singapore** ✓
- **URL**: https://contabo.com/en/vps/
- **Verdict**: Best raw value; includes RAM headroom; Singapore available. Renewal pricing is the catch.

### DigitalOcean — Straightforward, US-only
- **Plan**: Basic 2 GiB / 1 vCPU
- **Price**: $12/mo
- **Bandwidth**: 2,000 GiB (2TB) included
- **Overage**: $0.01 per GiB
- **Regions**: No Singapore
- **URL**: https://www.digitalocean.com/pricing/droplets
- **Verdict**: Transparent pricing; 2TB covers ~1-2 typical batches; egress at 50GB/mo = 100GB/6mo = $1/mo overage.

### Vultr — No Singapore Either
- **Plan**: Cloud Compute (2GB RAM / 1 vCPU)
- **Price**: $10–12/mo depending on CPU type (regular vs high-performance)
- **Bandwidth**: 2–3 TB included
- **Overage**: $0.01 per GB globally
- **Regions**: No Singapore
- **URL**: https://www.vultr.com/products/cloud-compute/ [403 forbidden; data from search results]
- **Verdict**: Competes with DO on price; same lack of SEA presence.

### Hetzner — EU Leader, Not Asia
- **Plan**: CPX22 (2 vCPU / 4GB RAM / 80GB SSD) — smallest with 2GB+
- **Price**: €5.99/mo (old), €7.99/mo (from April 2026)
- **Bandwidth**: 20 TB/mo in EU (exceptionally generous), 1 TB/mo in US, 0.5 TB/mo in **Singapore**
- **Overage**: €1.00/TB in US; €7.40/TB in Singapore
- **Regions**: Germany, Finland, US — **NO Singapore (despite search results claiming it)**
- **URL**: https://www.hetzner.com/cloud/pricing
- **Verdict**: Pricing went up in 2026; not in Asia; Singapore bandwidth overage is punitive (€7.40/TB).

### Linode/Akamai — Pricing Page Blocked
- **Status**: Fetch failed (403 Forbidden)
- **Data**: From search results, appears competitive but not differentiated
- **Verdict**: Skipped due to access issues; assume similar tier to Vultr/DO.

### Fly.io — Low Cost, High Egress Rate
- **Plan**: Shared-cpu-1x / 256 MB (minimal but works)
- **Price**: $2.02/mo base (Amsterdam), $2.21/mo (Singapore)
- **Bandwidth**: No included allowance; pay-as-you-go
- **Egress Cost**: $0.04 per GB (Asia-Pacific including Singapore)
- **URL**: https://fly.io/docs/about/pricing/
- **Verdict**: Base cost is lowest but egress at $0.04/GB kills the deal at scale. 50GB/mo = $2/mo. 1GB batch = $0.04 overhead.

---

## 2. Oracle Cloud Always Free (Game Changer?)

### Specs & Catch
- **Compute**: 2 ARM OCPU / 12 GB RAM (reduced from 4/24 in June 2026) [CONFIRMED reduction]
- **Storage**: 200 GB block volume
- **Egress**: 10 TB/mo free
- **Status**: **Permanent free, not trial** — no credit card auto-charge
- **Cost at 50GB/mo**: $0.00 + $0.00 = **$0/mo**
- **URL**: https://cloudpricecheck.com/free-tier/oracle, https://medium.com/@imvinojanv/setup-always-free-vps-with-4-ocpu-24gb-ram-and-200gb-storage-the-ultimate-oracle-cloud-guide-bed5cbf73d34

### Critical Issues
1. **Capacity**: "Often Out of Capacity in certain regions" — reported availability issues. You may need to retry provisioning or switch regions. No SLA on free tier.
2. **June 2026 Reduction**: Oracle silently halved limits from 4/24 to 2/12. Enforcement inconsistent (some users still run 4/24 with $0 bills).
3. **Region Lock**: Home region is permanent — careful selection required.
4. **Verdict**: **If you can get an instance, this is literally free forever.** Catch is availability and the 2/12 squeeze.

---

## 3. Fly.io (PaaS, Low Baseline)

- **Plan**: Smallest always-on VM (shared-cpu-1x / 256MB)
- **Base Cost**: $2.21/mo (Singapore)
- **Free Allowance**: None (legacy free tiers phased out October 2024)
- **Egress**: $0.04 per GB (Asia-Pacific)
- **Worker Option**: No native background worker; Cron job workarounds exist [UNVERIFIED cost impact]
- **Redis**: No built-in; require external (Upstash)
- **Cost at 1GB/mo uploads**: $2.21 + $0.04 = $2.25/mo
- **Cost at 50GB/mo uploads**: $2.21 + $2.00 = $4.21/mo
- **URL**: https://fly.io/docs/about/pricing/
- **Verdict**: Appealingly cheap base, but egress adds up. Suitable if truly low-bandwidth, but 50GB/mo batches kill it.

---

## 4. Render (Full PaaS, Expensive)

### Starter Tier Costs (2026)
- **Web Service (Starter)**: $7/mo
- **Background Worker (Starter)**: $7/mo
- **KV Redis (Starter 25MB)**: $10/mo
- **Free Tier**: 750 instance-hours/mo (works if you sleep 15min idle)
- **Bandwidth**: 100 GB/mo included in free tier
- **Overage**: [UNVERIFIED exact rate; search hints at $0.25+ per GB]
- **URL**: https://render.com/pricing, https://kuberns.com/blogs/render-pricing/
- **Cost at 1GB/mo**: $7 + $7 + $10 = $24/mo minimum
- **Cost at 50GB/mo**: $24 + (~$30 overage) = ~$54/mo [ESTIMATED overage]
- **Verdict**: Adds up fast. Fine for learning; not cost-effective for production.

---

## 5. Railway (Usage-Based PaaS)

- **Base Plan**: Hobby $5/mo (includes $5 credit for usage)
- **Pricing Model**: Per-second CPU/RAM/storage billing
- **Redis**: Persistent volume storage ~$0.15/GB-month for storage; CPU/RAM usage billed separately
- **Egress**: $0.05 per GB
- **Cost Estimate (rough)**: Redis (small) ~$5 + web app $10 + egress = $20–30/mo [UNVERIFIED, usage-based]
- **URL**: https://railway.com/pricing, https://docs.railway.com/pricing
- **Verdict**: Unpredictable costs; hidden per-second charges accumulate. Likely $20–50/mo for your workload.

---

## 6. Upstash Redis (Standalone Persistent Cache)

### Free Tier (Persistent)
- **Storage**: 256 MB
- **Commands**: 500K per month
- **Bandwidth**: 10 GB/mo
- **Persistence**: **Yes, data persists** ✓ (meets your requirement)
- **Cost**: $0
- **URL**: https://upstash.com/pricing/redis

### Paid Tier (Beyond Free)
- **Commands**: $0.20 per 100K commands
- **Storage**: $0.25 per GB-month (first 1 GB free)
- **Bandwidth**: Free up to 200 GB/mo, then $0.01 per GB
- **Estimated Small Upgrade Cost**: ~$5–10/mo if you exceed free tier

### Verdict
**Free tier handles your needs if commands stay under 500K/mo.** 1200 keys with moderate access (~400 requests/mo) fits comfortably. Suitable as secondary cache with optional paid upgrade if needed.

---

## 7. Google Cloud Always Free

- **Compute**: e2-micro (0.25–0.5 vCPU / 0.5–1 GB RAM)
- **Regions**: US only (us-west1, us-central1, us-east1) — **No Singapore**
- **Egress**: 1 GB/mo free
- **Cost Beyond Free**: ~$0.03–0.05/GB for egress
- **Verdict**: Under-spec'd for your worker + web split. US-only makes it unsuitable for Vietnam/Asia preference.

---

## 8. AWS EC2 (Not Viable for Free)

- **Free Tier**: t2.micro (1 vCPU / 1 GB RAM) for 12 months only
- **After 12 Months**: t3.micro ~$0.01/hr = ~$7/mo, t3.small ~$0.02/hr = ~$14/mo
- **Egress**: 100 GB/mo free, then $0.09/GB (US) to $0.15/GB (Singapore)
- **Verdict**: Loses free tier after 12 months. Not a long-term zero-cost option.

---

## Ranking Table: Real Costs at Different Upload Scales

| Provider | Plan | Base $/mo | Cost @ 1GB/mo | Cost @ 50GB/mo | Main Catch |
|----------|------|-----------|---------------|------------------|-----------|
| **Contabo VPS** | €5.50 | $6.00 | $6.00 | $6.00 | Unlimited (fair use); renewal rate unknown; 24mo lock-in |
| **DigitalOcean** | 2GB Droplet | $12.00 | $12.01 | $12.50 | No Singapore; transparent cost |
| **Vultr** | 2GB VPS | $10.00 | $10.04 | $10.50 | No Singapore; comparable to DO |
| **Fly.io** | Shared 256MB + Upstash | $2.21 | $2.25 | $4.21 | High egress cost ($0.04/GB); underspec'd VM |
| **Oracle Cloud Always Free** | 2 OCPU / 12GB | $0.00 | $0.00 | $0.00 | Capacity issues; June 2026 spec cut; permanent free |
| **Render** | Web + Worker + KV | $24.00 | $24.50 | $54.00 | Overage costs steep; overage rate unconfirmed [UNVERIFIED] |
| **Railway** | Hobby + usage | $5.00+ | $25.00+ | $50.00+ | Unpredictable usage charges; hidden per-second costs |
| **Google Cloud** | e2-micro (US only) | $0.00 | $0.09 | $4.50 | US-only, no Asia; spec'd too small |
| **Render (free tier only)** | Starter (900 mo) | $0.00 | Limited | N/A | Sleeps after 15min idle; expires after 30 days |

---

## Free Tier Combinations (Quirks & Gotchas)

### "Zero-Cost" Combo: Render Free + Upstash Free
- **Cost**: $0/mo base
- **Reality**:
  - Render free web: sleeps after 15 min idle (kills interactivity)
  - Render free Postgres: expires after 30 days (forces re-create)
  - Upstash free Redis: persists, no expiry ✓
  - Free bandwidth: 100 GB/mo (tight at 50GB/mo uploads)
- **Verdict**: Breaks on reliability (sleep), not on cost. Not production-viable.

### "Best Free" Combo: Oracle Always Free + Self-Hosted Redis
- **Cost**: $0/mo base
- **Reality**:
  - Oracle gives 2/12 ARM + 10TB egress free
  - Run Redis on ARM VM (built-in Aufs-capable Linux)
  - Data persists to 200 GB block storage (also free)
  - Perfect 10 TB egress covers 50GB/mo uploads perpetually
- **Verdict**: Genuinely free, production-capable. Catch is capacity; retries during provisioning expected.

---

## Unverified Numbers (Flagged)

| Item | Why Unverified |
|------|----------------|
| Contabo renewal pricing after 24mo | Promo only, renewal rate not listed |
| Render overage rate per GB | Search mentioned $0.25+ but no official source |
| Railway per-second CPU cost | Usage-based; no fixed rates given |
| Linode/Akamai current pricing | Page fetch 403 forbidden |
| AWS t3 instance pricing for Singapore | Fetch returned overview only, not rates |
| Hetzner Singapore region | Earlier sources claimed it exists; 2026 sources confirm no ASia presence |

---

## Recommendation

**For your specific workload:**

### Primary Choice: Contabo VPS (€5.50/mo = ~$6/mo)
- ✓ Includes Singapore
- ✓ Unlimited bandwidth (fair use)
- ✓ 8GB RAM + 4 vCPU (comfortable headroom for web + worker)
- ✓ Proven provider with stable track record
- ⚠ Renewal pricing after 24 months unknown
- **Action**: Verify renewal cost before committing; check SLA on "fair use" clause

### Backup: Oracle Cloud Always Free ($0/mo)
- ✓ Genuinely permanent free
- ✓ 10 TB/mo egress covers 50GB/mo uploads forever
- ✓ 2 OCPU / 12GB RAM acceptable (tight, but works)
- ⚠ Capacity issues common; provisioning may require retries or region switches
- ⚠ June 2026 spec cut (4/24 → 2/12) may happen again
- **Action**: Have Contabo as fallback if provisioning fails; test capacity in your home region

### Avoid: Render, Railway, AWS after free tier
- Costs compound to $25–60/mo as you add services
- Usage-based billing unpredictable

### Avoid: Fly.io, Google Cloud for Asia
- No Singapore/SEA presence (Fly offers it; Google doesn't)
- Egress costs kill economics at 50GB/mo scale

---

## Next Steps

1. **Verify Contabo renewal rate**: Email support for 24mo → month 25 pricing
2. **Test Oracle provisioning**: Try creating a 2/12 ARM instance in your preferred region; note if out-of-capacity
3. **Measure Redis command rate**: Log actual commands/mo; validate 500K free tier ceiling at Upstash
4. **Set bandwidth alert**: Render or Railway billing alerts if you overspend on overage

---

## Unresolved Questions

1. What is Contabo's renewal pricing after 24-month promo expires?
2. Does Render's free 100 GB/mo bandwidth actually cover PaaS or is it only for Postgres?
3. What is Railway's actual per-second CPU cost for a small background worker?
4. Will Oracle ever cut the free tier again below 2/12?
5. Do Vietnamese hosting providers (e.g., VDC Hosting, FPT Cloud) offer lower prices? (Search did not surface local player)

