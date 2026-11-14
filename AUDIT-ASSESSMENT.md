# 环卫/清雪智慧运营管理平台 — 质量与可行性综合评估

*Consolidated quality & feasibility assessment — external audit + market research + build plan. 2026-11-13.*

**Sourcing convention:** **[code]** = verified directly against this repository this session (line numbers cited); **[web]** = from cited public sources gathered this session; **[doc]** = from a second research pass supplied during the audit, not independently re-verified. All scenario details (18 employees, 9 roles, 2026-12-03 snow event, SOP-01/02/03/08) come from this repo's own docs and code.

---

## 1. Assumptions (read first — every recommendation below is conditioned on these)

**Customer & business**

1. **A1.** The real customer is a single 项目公司 running one 政府购买服务 contract — the org in this repo's own scenario — not a city-wide platform sale. County-level, <100 staff. *(If wrong → this becomes a channel/partnership play; stop building.)*
2. **A2.** The buyer's pain is not "no AI": it is defending 履约考核/履约金 against 城管局 and keeping labor cost honest. **[web]** Verified demand-side evidence: 主管部门 绩效抽查 found 年平均人员配置率 **75%** (one contract: 935人约定 vs 699在岗; worst case 60%) — headcount evidence is a cash question on both sides of the table. Labor = 60–88% of project operating cost (嘉鱼 >60%; 梁山县 88%).
3. **A3.** Budget is tight; willingness-to-pay is in the low thousands of RMB/month band; a ¥500/mo cloud VPS or Caddy LAN deployment is the cost ceiling. ICP filing for one province is acceptable.
4. **A4.** Government clients want private/on-prem deployment; a single-tenant container deployable on the project's own LAN is the default, cloud VPS as fallback. *(If 甲方 mandates a specific vendor's cloud → we become a data-entry edge; exit.)*

**Market & regulatory**

5. **B1.** The big players' cost structures keep them out of small single-project accounts (**[doc]** inference, consistent with their reported contract scale [web]). None of the three platforms below is a purchasable product for an independent small 项目公司.
6. **B2.** We cannot win on platform breadth — only on (i) a compliance bridge to 甲方/城运平台考核 and (ii) radically lighter deployment than anything in segment.
7. **B3.** **The compliance interface is being standardized now.** **[web]** National standard plan **20262742-T-333《城市运行管理服务平台 第25部分：环卫运行监管》** entered drafting 2026-05-22 (std.samr.gov.cn); 住建部+国标委's 城运平台标准体系 already names 市容环卫 as one of four regulated domains on a 国家/省/市 three-tier platform (CJJ/T312-2021, CJ/T545-2021). *This is the upgraded version of the assumption that the 聊城 pattern generalizes — it's now a national specification in progress, which de-risks a "design target, build later" 城运 export.*
8. **B4.** **[doc]** Equipment-neutrality is a hard constraint: we integrate with 甲方-mandated devices only at data-import level; we build no hardware, sell no badges, take no telemetry dependency.

**Technical**

9. **C1.** Any multi-user behavior needs a real backend. **[code]** Verified: exactly 1 `localStorage` call per page; no sync mechanism; BroadcastChannel/localStorage cannot sync across devices — current architecture breaks mobile field use.
10. **C2.** We will NOT build: GIS maps, vehicle telemetry, LLM features, real-time comms, big-data dashboards, autonomous dispatch. **[code]** And note the existing "real-time" layer is fake — `Math.random()` generates not just vehicle telemetry (`index.html:3718-3720`) but also the IoT device list (`4210-4214`), message throughput (`3950`), file sizes (`4702/4742/5062`) and chat replies (`10792`). It is a UI shell, not a feature to extend.
11. **C3.** **[doc]** Fall back to paper for any capture problem that needs hardware (fraud-resistant punch-in for dispersed workers, vehicle positioning). Do not solve hardware problems in software.
12. **C4.** Data protection: county government clients operate under PIPL; single-tenant + LAN/private deployment is also the compliance answer. **[doc]**

---

## 2. The market: three mature players, plus two context bars

Peer-set note: the first research pass chose 盈峰/福龙马/玉禾田 (equipment bar + pure-ops mirror); the second chose 盈峰/侨银/中环洁 (operator platforms). Both answer different questions. Merged, the most instructive trio for *equipment-neutral management software* is **盈峰 / 玉禾田 / 侨银**, with 福龙马 and 中环洁 retained as context bars (what we must export to, not who we compete with).

### 2.1 盈峰环境 (000967) — "智能装备 + 智云平台", the soft+hard bar

**Solution & architecture** **[web]**. "端–管–云": self-developed **T-BOX** terminal on vehicles → connectivity → **智云平台**, split into **ICS2.0 智慧运营系统** (全栈自研微服务架构 + 统一大数据) for operations and **启元云脑** for perception/decision (多模态大模型 + 无人机/无人车立体感知). "智云为脑、装备为基、集群协同". Scale (2025 annual report, the authoritative source — resolves earlier conflicting figures): **7.7万 DAU, 21.5万 IoT devices**. 2026H1: equipment sales 8,210 vehicles (+31.2%), 23.0% share, #1 for the 25th consecutive year. Showcase: 深圳大运中心 全运会. **[doc, not re-verified]** acquired Zoomlion's environment arm in 2018; 389 city-service projects / ¥64.8B cumulative contracts / 1,399 patents.

**Strengths.** The only player with a real software–hardware flywheel; data volume nobody else has; cash-rich relative to peers (三季报 headline: cash ~¥3.9B more than peers).

**Weaknesses** *(inference)*. Platform optimized for its own fleet — a small project with mixed and *rented* vehicles (this repo: 6 rented loaders, 18 rented snow trucks **[code/doc]**) is a structurally poor fit; asset-heavy sales motion ignores small single-project accounts; 应收账款 ¥6.19B pulls it toward mega一体化 clients.

**Implication for us.** Don't compete on breadth or hardware — its cost structure leaves exactly our segment unserved. But **[web]** tender scoring is moving: 多地已出现将无人驾驶设备写入招标评分规则, so we need a **data-export story, not a robot**.

### 2.2 玉禾田 (002815) — pure operations, the closest mirror

**Solution & architecture** **[doc, not re-verified]**. Pure government-purchased-service operator; ~¥100B+ cumulative contracted projects; its management system is **internal operations software, not a product** — operations-scenario-driven, R&D ≈1.2% of revenue, private deployments per client, no SaaS channel at all. **[web, verified]** Its 2026 三季报: 毛利率 +5.61pct (cost-control-driven), 经营现金流 ¥2.86亿 (**−45.8%**), 应收账款 **¥5.34亿 and climbing** — the same AR strain as 侨银.

**Strengths.** The most accurate DNA mirror of this repo's target user: same business (政府购买服务), same cost structure (labor-heavy), same clients (城管局). It *proves* both that operations-scenario software fits contractors, and that nobody in this segment has a purchasable product.

**Weaknesses.** Its margin repair is cost-cutting, not software leverage; its internal system doesn't reach independent 项目公司; growth-by-AR under stress.

**Implication for us.** This is the validation of the wedge: what 玉禾田 built internally for scale, we sell externally at the bottom of the market — and its financial stress means it will not come down-market to fight us.

### 2.3 侨银股份 (002973) — "城市大管家", the scale benchmark

**Solution & architecture** **[web]**. Runs a **数字孪生 central brain** in Guangzhou managing **27 provinces / 100 cities / 500+ projects / 6万 employees / 4万台 ground devices** — "AI智慧平台+智能装备+产业生态", in production since its 智慧环卫平台 launched 2017. Newest layer: **环域智管Agent** (CICAS AI Agent global competition, 成长组 champion), architecture "1 个AI城市治理智能体矩阵平台 + X 个无人设备模块 + N 个应用场景".

**Strengths.** Only operator with battle-tested platform scale across 500+ projects (multi-project benchmarking, cross-city economies); strongest 城市大管家 brand with governments; moving aggressively to agent-based dispatch.

**Weaknesses** **[web]**. Financially stretched: 2026H1 营收 16.32亿 (**−12.76%**), 归母净利 4,357万 (**−65.08%**); 应收账款+合同资产 35.45亿 = **42.95% of total assets ≈ 1.43× of nine-month revenue**. Its platform is an internal capability, not a sold product.

**Implication for us.** This is the bar our tool will be measured against ("侨银有全国看板，你给我什么?"). The only answer scale players structurally cannot give: a tool that fits THIS project's 18 people, 9 roles and specific 甲方考核条款.

### Context bars (not competitors — integration targets)

- **福龙马 (603686)** **[web]**: equipment maker, 2026H1 NEV sanitation vehicle sales 12,299 units (+99% YoY) — defines the *equipment/tender* bar; its platform story is vehicle-mounted IIoT, not operations management.
- **中环洁** **[web]**: "感知–决策–执行–优化" — 智能巡检 → 无人驾驶运营管理平台 → L4 fleet (WeRide, 300-unit order; 沈阳铁西区 12× L4 S6, first 整建制全场景 fleet; 车辆利用率+40%, 作业时长+50%, 能耗−20%; sub-¥200k L4 replacing 3 workers = ~2年回本). 2026H1 营收 11.42亿 (+4.85%), 毛利率 29.92%. **This is the autonomy trajectory the buyer's 考核 is migrating toward** — toward "结果可测".
- **北控城市服务** **[web]**: SOE default (冬奥2022智慧环卫, AI路线规划, 投资决策→考核评估 full chain; 哈密 168 roads) — the safe benchmark the 甲方 may imagine when hearing "平台".

### Synthesis

| | 盈峰环境 | 玉禾田 | 侨银股份 | ← the gap |
|---|---|---|---|---|
| Business model | Equipment + platform | Pure ops (internal software) | Service operator (500+ projects) | **No purchasable lightweight tool for a single ~18-person 项目公司** |
| Platform is… | Sold with own hardware | Internal, never productized | Internal to own workforce | **All three are closed stacks** |
| Scale moat | T-BOX data (21.5万 devices) | Ops know-how, AR-constrained | 500-project ops data | — |
| Segment they leave | Small mixed/rented fleets | Independent small 项目公司 | Small single-project accounts | **Our wedge** |
| Shared pressure point | 履约考核 / 配置率 / 应收 | same | same | **The one thing a small tool can serve at any scale** |

---

## 3. What to build — feasibility × business value

| Candidate sub-system | Business value | Tech risk | Verdict |
|---|---|---|---|
| **A. 物资发放 + 库管 循证链 (chain of custody)** | **High** | **Low** | ✅ **Primary** |
| **B. 考核绩效 scorecard (the 履约金 score)** | **High** | Low–Med | ✅ **Secondary** (consumes A + attendance data) |
| 考勤/人员到岗 | High demand, weak capture | **High without hardware** | ⬇️ Demoted to **input data** for B (20% weight), captured at low fidelity (班组长点名) |
| 审批表单引擎 | Med | Low | Substrate for A, not standalone |
| 车辆管理/调度 | Med | High (telematics) | ❌ Out; the existing module is `Math.random()` theater **[code]** |
| 品质巡检 | Med | Med (photo ok, AI识别 no) | Later phase, photo-only |
| GIS / 实时通讯 / LLM / ECharts报表 / 应急指挥 (the 10-module plan) | — | — | ❌ Where the big players spend 2.5亿; demo-ware |

**Why A over an attendance-first pick** *(the correction a second research pass made, now code-verified)*:

1. **Hardening, not greenfield.** **[code]** The materials/warehouse engine is already the most-built subsystem in `index.html`: domain constants `inventoryItems`/`inboundRecords`/`outboundRecords`/`materialDistributions`/`materialRequisitions` (1946/1960/1989/2012/2144), and a working 4-step state machine `autoMatchRecipients → calcTotalFromUnits → generateDistributionWorkflow → executeMatDistStep` (2086/2118/2134/7942/7985), with real warehouse math — inbound increments `stock`, outbound validates `qty ≤ stock` then decrements, `stock < minStock` flags, `approvalId`/`relatedDistId`/`qualityCheck` linkage (1998, 1984) all present as business logic, not mock.
2. **The capture problem is solvable in software.** The materials handoff happens at a defined two-party point (发放人→接收人, 仓库→发放人) — timestamped, user-attributable, geo-stampable records are genuine evidence. Attendance, by contrast, needs fraud-resistant punch for 保洁员 dispersed across streets — a hardware problem we've assumed away (C3).
3. **It threads the storyline.** **[code]** SOP-08 清雪应急预案 (`项目正式文档.md:424`) is this repo's core driver scenario, and its literal path is 12-01/02 车辆改装→融雪剂/备品出库→班组领取→清雪作业 — i.e., the materials chain *is* the snow scenario's spine.
4. **The mobile gap is confirmed.** **[code]** `mobile.html`'s materials module is display-only — the 发放申请 button shows the toast `请在网页版发起完整发放流程` (`mobile.html:1559`). The field sign-off screen doesn't exist yet; that is the feature.

**Why B is the right home for the compliance story** (better than "export a 履约档案"): B *produces the score* — the number the 甲方 links to 履约金 — and §十 of `platform-upgrade-plan.md` already specifies it: 绩效总分 = 出勤20% + 作业质量30% + 任务完成25% + 安全合规15% + 协作10%, with `WEIGHT_PROFILES`, S–D grading and radar visualization (lines 1189/1205, **code-verified**). Build the four hard dimensions; defer 协作's 10% until it earns its keep.

---

## 4. The plan

### Phase 0 — make the demo honest (foundation)
Keep `index.html` (616KB of working UI beats a rewrite) but re-platform the data layer behind it: one thin server (SQLite/Postgres, single container, single-tenant per project, LAN-deployable per this repo's own Caddy plan); backend RBAC replacing the hard-coded `permissions:['all']` login; offline-tolerant sync (queue field writes, reconcile on reconnect — replaces the impossible BroadcastChannel design); delete the orphaned `js/app.js`, `js/data.js`, `css/style.css`; resolve the doc-vs-doc contradiction (正式文档 §4.1 volatile-data claim vs SOLUTION-DOC localStorage baseline).
**Gate:** one project, multiple real users, one month, data survives refresh and device switching.

### Sub-system A — Materials chain-of-custody (primary)
- **State machine (server-authoritative):** 申请 → 仓库确认出库 → 发放人确认接收 → 发放人移交 → 接收人签收, each transition an atomic, audited event `{actor, timestamp, geo, note}`; existing client logic becomes the UI on top of server-side state.
- **Inventory:** inbound (with `qualityCheck` 质检) increments `stock`; outbound validates `qty ≤ stock` then decrements atomically; `minStock` triggers safety-stock alerts (手套1,200双 / 口罩30,000付 thresholds already in this repo's risk table).
- **Mobile sign-off screen** (extend `mobile.html`): 接收人签收 / 发放人移交 with timestamp + user attribution; offline-queued.
- **Export:** a 城运-shaped event feed (design target per B3 — build the adapter when 第25部分 firms up).

**Success metrics:** every completed 发放 traceable end-to-end to a named 签收人 (100%); 库存预警提前期 ≥7天; offline field writes reconcile with zero loss for a full month; one full SOP-08 snow standby (12-01/02 备料出库→班组领取) closed in-system.

### Sub-system B — 考核绩效 scorecard (secondary, on the same engine)
Implement §十's model on the four hard dimensions (出勤20% + 作业质量30% + 任务完成25% + 安全合规15% = 90%, with 协作's 10% parked). Attendance is *input* here: low-fidelity 班组长点名 rather than self-punch; auto-derive 任务完成 from A's closed chains and 奖惩 records; monthly 履约 score exportable as PDF + the 城运-shaped JSON.
**Success metrics:** ≥90% of the monthly score auto-derived from system records (no manual re-tally); score fields map 1:1 onto the existing 甲方考核表 (gate: used in one real 考核 submission).

### Sequencing with gates (order only — no dates)
**Phase 0 → A → B → 城运 bridge** (adapter built when the standard firms up; photo-only 品质证据 optionally appended to B). Each phase's gate above is a go/no-go; nothing starts before the previous gate clears.

### What we never build
GIS maps, vehicle telemetry, LLM "AI能力" (keep the `callLLM()` stub as a documented interface and stop calling the keyword rule engine "AI能力"), real-time comms, big-data dashboards, autonomous dispatch.

---

## 5. Kill criteria (if any assumption breaks, stop and pivot)

- **A1 wrong** (actually aiming at multi-project/multi-city sales) → the single-project wedge is wrong; becomes a partnership play — stop building.
- **A2 wrong** (甲方 doesn't actually tie 履约金 to scoring, or 甲方 runs its own platform and only wants data feeds) → A+B's value collapses; consider becoming an implementation/data-edge partner.
- **A4/B1 wrong** (a big player does come down-market with a lightweight SaaS, or 甲方 mandates a specific vendor cloud) → exit; we can't out-spend them.
- **B3 reverses** (城运 enforcement weakens) → the compliance justification fades; pivot A+B to pure internal 劳务/物资成本控制 — the build barely changes, the story does.
- **Phase 0 gate fails twice** (data layer can't hold across devices/network) → the product premise fails; revert to the offline single-file demo as a sales aid only.

---

## Verification appendix — the second research pass, checked against the code

| Claim | Verdict |
|---|---|
| Domain model `inventoryItems`/`inboundRecords`/`outboundRecords`/`materialDistributions`/`materialRequisitions` | ✅ True (index.html:1946/1960/1989/2012/2144) |
| 4-step workflow `autoMatchRecipients → calcTotalFromUnits → generateDistributionWorkflow → executeMatDistStep`, step-3 → `showTransferModal` | ✅ True (2086/2118/2134/7942/7985) |
| Real warehouse math, `approvalId`/`relatedDistId`/`qualityCheck` linkage, `workUnits.leaderId` | ✅ True (1998/1984, 1802-1811) |
| Vehicle telemetry simulated via `Math.random()` | ✅ True (3686, 3718-3720) — and **understated**: also the IoT list, message throughput, file sizes, chat replies |
| Performance model "fully specified in §十" (5-dimension weights, `WEIGHT_PROFILES`, S–D, radar) | ✅ True (platform-upgrade-plan.md:1189/1205) — nit: ~250 spec lines, not "~1200" |
| `mobile.html` as basis for sign-off screen | ✅ True — currently display-only, toast redirect at mobile.html:1559 |

Unverified figures carried forward with flags: 盈峰 389 projects / ¥64.8B contracts / 1,399 patents; 玉禾田 ~¥100B cumulative projects. 盈峰 platform scale discrepancy resolved to the 2025 annual report: 7.7万 DAU / 21.5万 IoT devices.

---

## Sources

- 盈峰环境: [2025 annual report (智云平台, 7.7万 DAU, 21.5万 IoT, ICS2.0微服务)](https://www.inforeenviro.com/upload/file/2026-05/col23/1779418188426.pdf) · [上海证券报 2025年报摘要](http://paper.cnstock.com/html/2026-04/28/content_2208385.htm) · [2026H1 半年报 (装备销量/市占率/应收61.9亿)](https://stock.stockstar.com/notice/SN2026082700055342.shtml) · [界面新闻](https://m.jiemian.com/article/15014080.html) · [三季报 roundup (现金优势)](http://m.toutiao.com/group/7703122207483888138/)
- 玉禾田: [新浪财经/环境司南 三季报综述 (毛利率+5.61pct, 经营现金流−45.8%, 应收53.39亿)](http://m.toutiao.com/group/7703122207483888138/)
- 侨银股份: [人民网民生周刊 (数字孪生中央大脑 500+项目/6万员工)](http://paper.people.com.cn/mszk/pc/content/202511/24/content_30119815.html) · [中国日报 (环域智管Agent)](http://cnews.chinadaily.com.cn/a/202601/14/WS69670ebea310942cc499b31d.html) · [投资者关系活动记录 2026-09-23 (2026H1财务)](http://www.cnfin.com/announ/detail/index.html?announ=lc&code=002973&dannoun=lcdetail&id=843533760750) · [新浪财经 (应收/合同资产占比42.95%)](https://finance.sina.com.cn/stock/estate/integration/2026-10-29/doc-iniwxksk5878085.shtml.md)
- 中环洁: [官网 AI+城服](https://www.clean-pro.cn/site/detail?navigation_id=4&navigation_child_id=17&id=356) · [新华网](https://www.xinhuanet.com/energy/20260331/08b7b3fdd0ef44e8bacbc7f9545250b3/c.html) · [央广网](http://www.cnr.cn/ln/zxh/20260324/t20260324_527561230.shtml) · [半年度报告 2026](https://pdf.dfcfw.com/pdf/H2_AN202608271828535156_1.pdf) · [WeRide战略合作300台](https://www.weride.ai/zh/posts/exvzddcyq4pinlwtdnbcg393) · [AsiaICT 成本逻辑](https://www.asiaict.com/smartcity/15208.html)
- 福龙马 / 北控: [福龙马经营分析](https://stockpage.10jqka.com.cn/603686/operate/#intro) · [新华网 北控冬奥体系](http://www.news.cn/energy/20220112/dead1ba013994a7886589a39418c2bdd/c.html) · [中新网新疆 哈密168条路](http://www.xj.chinanews.com.cn/dizhou/2026-08-11/detail-ihfieyqp7837828.shtml)
- 政策: [住建部+国标委 城运平台标准体系建设指南](https://www.mohurd.gov.cn/gongkai/zc/wjk/art/2024/art_17339_776909.html) · [全国标准信息公共服务平台 计划20262742-T-333](https://std.samr.gov.cn/search/orgOthers?q=%E5%8C%97%E4%BA%AC%E6%95%B0%E5%AD%97%E6%94%BF%E9%80%9A%E7%A7%91%E6%8A%80%E8%82%A1%E4%BB%BD%E6%9C%89%E9%99%90%E5%85%AC%E5%8F%B8) · [三级平台 CJJ/T312-2021](http://www.cstid.org.cn/hxyw/003010/003010004/003010004001/20220329/02d1fa7b-05c7-4e58-9326-d8d14aae9f2d.html)
- 行业成本与考核: [湖北住建厅 嘉鱼案例](https://zjt.hubei.gov.cn/bmdt/dtyw/szsm/202605/t20260514_5936368.shtml) · [梁山县成本效益分析](http://www.liangshan.gov.cn/module/download/downfile.jsp?classid=0&filename=e157898d31eb44d9b2cfda2d996ac51c.pdf) · [EET-China 无人环卫报告](https://www.eet-china.com/mp/a430812.html) · [新浪财经 绩效抽查配置率75%](http://m.toutiao.com/group/7681652522443915818/) · [上海证券报 招采换手季](https://m.cnstock.com/commonDetail/803238) · [环境司南 国企年化额53%](https://finance.sina.com.cn/roll/2026-07-05/doc-inifutnn2277027.shtml)
