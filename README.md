# Talkalong

把一张手绘风格的绘本插画变成可以"对话+被打断"的活绘本：

1. **静态绘本动画 (Remotion)** — 一张成品图 → 一段 ~10 秒"渐进式绘本动画"（线稿一笔一笔画出来，颜色慢慢晕染，整体呼吸+漂浮）。
2. **会讲故事的语音 tutor (Next.js + Agora)** — 用 LLM 生成 5 段故事剧本，配上 Gemini 生成的插画，由 Agora 实时语音管线朗读，小听众可以随时打断提问，问完会被巧妙圆回主线。

---

## 仓库结构

```
talkalong/
├── src/                       # Remotion 端：图 → 渐进式绘本视频（本目录顶层 npm 项目）
│   ├── BookPage.tsx           # 主组合
│   ├── preprocess.ts          # 一张图 → 线稿 + 颜色层
│   └── Root.tsx
├── agora-voice-demo/          # Next.js + Agora 语音 tutor 子项目（独立 pnpm 项目）
│   ├── app/api/tutor/         # SSE narration + qa-ended 路由
│   ├── lib/orchestrator/      # 状态机、Q&A 中断、resume planner、bridge
│   ├── lib/lesson/            # 用户输入 → 5 scene 剧本 + 插画 + 视频
│   ├── components/tutor/      # 前端故事书 UI
│   └── scripts/qa-bench/      # QA & resume 回归基准（11 个 case）
├── docs/                      # 设计文档 / 实验结论 / PRD
│   ├── plans/                 # 实施计划
│   ├── experiments/           # 完整带数据的 A/B 实验
│   └── screenshots/           # 截图
└── public/                    # Remotion 端的输入图素材
```

两个子项目是独立的 npm/pnpm 项目，互不依赖；共用 `docs/` 当公共大脑。

---

## 快速上手

### A. 跑 Remotion 静态绘本动画

```bash
npm install                              # 第一次会下 Chromium，1–2 分钟
npm run generate                         # = preprocess demo_img.jpeg + render
open out/video.mp4
```

详情见 [docs/video_story_README.md](docs/video_story_README.md)。

### B. 跑 Agora 语音 tutor

```bash
cd agora-voice-demo
pnpm install
cp env.local.example .env.local           # 填上 Agora App ID + Cert + GOOGLE_API_KEY
pnpm run dev                              # http://localhost:3000/tutor
```

详情见 [agora-voice-demo/README.md](agora-voice-demo/README.md) 和 [agora-voice-demo/AGENTS.md](agora-voice-demo/AGENTS.md)。

---

## 文档

- 项目愿景 / PRD: [docs/proactive_engine_README.md](docs/proactive_engine_README.md)
- Remotion 端说明: [docs/video_story_README.md](docs/video_story_README.md)
- 实施计划: [docs/plans/](docs/plans/)
- 实验 + 数据 + 结论: [docs/experiments/](docs/experiments/)
  - `2026-05-27-e1-agora-narration-control` — Agora 主动叙述 control
  - `2026-05-28-e1.5-gemini-model-pick` — Gemini 模型选型
  - `2026-05-28-qa-resume-benchmark` — QA & 续讲回归基准（**11 个 case，用于回归门**）

---

## 测试 + 类型检查

```bash
cd agora-voice-demo
pnpm run typecheck                       # tsc --noEmit
pnpm test                                # vitest，80 个 unit test
pnpm run verify                          # 完整管线 (typecheck + api contract + build)
```

QA 回归基准（每次改 [agora-voice-demo/lib/orchestrator/index.ts](agora-voice-demo/lib/orchestrator/index.ts) 的 `DEFAULT_PERSONA` 或 [agora-voice-demo/lib/orchestrator/resume-planner.ts](agora-voice-demo/lib/orchestrator/resume-planner.ts) 的 `SYSTEM` 之前跑一次）：

```bash
cd agora-voice-demo
pnpm tsx scripts/qa-bench/extract-baseline.ts
pnpm tsx scripts/qa-bench/run.ts \
  --prompts docs/experiments/2026-05-28-qa-resume-benchmark/prompts/baseline.json \
  --out docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-$(date +%Y%m%d).json
```

详见 [agora-voice-demo/scripts/qa-bench/README.md](agora-voice-demo/scripts/qa-bench/README.md)。

---

## License

MIT — 见 [LICENSE](LICENSE)。

agora-voice-demo 子项目最初 fork 自 [AgoraIO-Conversational-AI/agent-quickstart-nextjs](https://github.com/AgoraIO-Conversational-AI/agent-quickstart-nextjs)（MIT），已重度定制为故事书 tutor。
