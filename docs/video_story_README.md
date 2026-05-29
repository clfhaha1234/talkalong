# storyImgToVideo

把一张手绘风格的绘本插画（铅笔线 + 水彩）转成一段约 10 秒的"渐进式绘本动画"——线稿被一笔一笔画出来，颜色慢慢晕染进去，整体轻微呼吸+漂浮，最后淡出。适合做 bedtime storytelling、AI 绘本视频、Apple TV / Calm / Netflix 那种"会呼吸的绘本"风格。

不需要预先准备线稿层和颜色层，输入一张成品图就行。

---

## 时间轴

```
0s ──── 2.5s ──── 4s ─────────────────── 9.5s ── 10s
│ 线稿一笔一笔画出来 │
            │ 颜色 opacity 0→1 + blur 8→0px │
                    │ 整体呼吸 + Ken Burns 推拉 │
                                            │ 淡出 │
```

每条 path 独立亚像素 wiggle（手绘活感），路径绘制顺序每次跑都不一样（同 seed 可复现）。

---

## 环境要求

- Node.js ≥ 18（开发用 23.6）
- macOS / Linux（Windows 没测过，理论可行）
- 磁盘 ~1.5 GB（含 Remotion 自带的 Chromium）
- 可选：系统级 `ffmpeg`，用来做产出后的校验/抽帧

---

## 快速上手

```bash
git clone <this-repo>
cd storyImgToVideo
npm install                              # 第一次会下 Chromium，1–2 分钟

# 用默认 demo 跑一遍
npm run generate                         # = preprocess demo_img.jpeg + render
open out/video.mp4
```

换成你自己的图：

```bash
cp /path/to/your_picture.jpg .
npm run preprocess -- your_picture.jpg
npm run render
open out/video.mp4
```

实时调参（浏览器里改 seed/时间轴看效果）：

```bash
npm run preview                          # 打开 Remotion Studio
```

---

## 工作原理

```
┌────────────────────────────────────────────────────────┐
│  输入: your_picture.jpg                                 │
└────────────────────────────────────────────────────────┘
              │
   ┌──────────┴──────────┐
   ▼                     ▼
┌───────────┐     ┌───────────────┐
│ 预处理      │     │ 复制为颜色层    │
│           │     │               │
│ sharp 灰度 │     │ public/       │
│   ↓ 阈值   │     │  color.png    │
│ potrace 矢量化│  └───────────────┘
│   ↓ 路径切割
│ public/
│  lines.svg
└──┬────────┘
   │
   │ 同时四角 patch median 采样 → bgColor
   ▼
public/meta.json (width, height, pathCount, bgColor)
              │
              ▼
┌──────────────────────────────────────────────┐
│  Remotion 合成 (src/BookPage.tsx)             │
│                                              │
│  • 每条 SVG path stroke-dashoffset 描边动画   │
│      └ 路径顺序 shuffle + 时间 ±jitter        │
│  • 颜色层 opacity 0→1 + blur 8→0             │
│  • Ken Burns 缓慢推拉 + 平移                  │
│  • 整体呼吸 (sin 缩放)                         │
│  • 每条 path 独立亚像素 wiggle                 │
│  • 末端 fade out                              │
└─────────┬────────────────────────────────────┘
          ▼
       out/video.mp4
```

预处理是一次性的：换图片才需要重跑 `npm run preprocess`，调动画/时间轴只重跑 `npm run render`。

---

## 项目结构

```
storyImgToVideo/
├── demo_img.jpeg              # 自带 demo 图
├── package.json
├── tsconfig.json
├── src/
│   ├── preprocess.ts          # sharp + potrace + 四角采样 → public/
│   ├── index.ts               # Remotion 入口 (registerRoot)
│   ├── Root.tsx               # Composition 声明 + defaultProps
│   ├── BookPage.tsx           # 主合成：所有动画层
│   └── rng.ts                 # mulberry32 PRNG + Fisher-Yates shuffle
├── public/                    # 预处理产物 (gitignored)
│   ├── lines.svg
│   ├── color.png
│   ├── _lines_bitmap.png      # 调阈值时用来 debug
│   └── meta.json
└── out/                       # 渲染产物 (gitignored)
    └── video.mp4
```

---

## CLI 参数

### 预处理 (`npm run preprocess -- <image> [flags]`)

| flag | 默认 | 说明 |
|------|------|------|
| `--threshold` | `140` | 二值化阈值 0–255。线条不清的图调低到 100–120；噪点多调高到 160 |
| `--blur` | `0.5` | potrace 前的高斯模糊半径。值越大越平滑、越少碎线 |
| `--turd-size` | `4` | 过滤小于 N 像素的孤立斑点。噪点重的图调到 20 |

例：

```bash
npm run preprocess -- my_pic.jpg --threshold 120 --blur 1.0 --turd-size 10
```

### 渲染 (`npm run render`)

默认每次跑用一个新的随机 seed，所以**每次结果都不一样**（绘制顺序、镜头方向、wiggle 相位都变）。要复现某一次：

```bash
npx remotion render src/index.ts BookPage out/v.mp4 \
  --props='{"seed":42,"linesSvgPath":"lines.svg","colorImagePath":"color.png","bgColor":"#cf8f6c"}'
```

可传的 props：

| prop | 类型 | 说明 |
|------|------|------|
| `seed` | `number` | 32-bit 整数。固定它就能像素级复现（SHA-256 验证过）|
| `linesSvgPath` | `string` | 默认 `"lines.svg"`，相对 `public/` |
| `colorImagePath` | `string` | 默认 `"color.png"`，相对 `public/` |
| `bgColor` | `string` | 默认是 `meta.json` 里采样到的颜色，可手动覆盖 |

---

## 关于随机性

每次 `npm run render` 默认会产出"几乎不一样"的视频，分三个维度：

1. **路径绘制顺序 + 时间抖动**——线稿一笔一笔出现的顺序每次都不同，每条 path 的开始时间还在自己时槽内 ±90% 抖动。看着像不同的人在画。
2. **Ken Burns 微镜头**——整图缓慢推/拉/平移，方向和幅度都随机。
3. **每条线独立 wiggle**——每条 path 有自己的相位/幅度/频率，看着像活的纸笔线条。

所有这些都由一个 `seed` 完全决定。同一个 seed 跑两次，输出**字节级一致**（用 `ffmpeg` 提取 raw 像素 + SHA-256 实测）。不传 seed = 每次新的；传了 seed = 锁定可复现。

背景色不属于随机性——它是从输入图四角 8×8 patch 取 per-channel median 算出来的，跟着图走。蓝调输入图自动出蓝底视频，暖调出暖底视频。

---

## 调参速查

效果不对的时候先看这里：

| 现象 | 怎么调 |
|------|--------|
| 线稿提取太碎、太多斑点 | `--threshold 120` + `--blur 1.0` + `--turd-size 20` |
| 线稿断断续续、缺失主要线条 | `--threshold 160` + `--blur 0.3` |
| 想检查 potrace 的输入到底干不干净 | 看 `public/_lines_bitmap.png` |
| 动画太快/太慢 | `src/BookPage.tsx` 顶部的 `PHASE` 常量 |
| 镜头推太多想要更静 | `src/BookPage.tsx` 里 `buildRandomState` 的 `kenBurns.endScale` 改小 |
| 每条线抖得太厉害 | `buildRandomState` 里 `ampX/ampY` 的范围调小 |
| 视频太短/太长 | `src/Root.tsx` 顶部的 `DURATION_SEC` |

---

## 验收/调试

```bash
# 视频元数据
ffprobe -v error -show_entries stream=width,height,duration,r_frame_rate \
  -of default out/video.mp4

# 抽 4 个关键帧目视检查 4 个阶段
for ts in 0.5 2.5 5.0 9.7; do
  ffmpeg -y -ss $ts -i out/video.mp4 -frames:v 1 out/frame_t${ts}.jpg
done

# 验证 seed 确定性：两次 seed=1 渲染像素哈希应相同
npx remotion render src/index.ts BookPage out/a.mp4 --props='{"seed":1,"linesSvgPath":"lines.svg","colorImagePath":"color.png","bgColor":"#cf8f6c"}'
npx remotion render src/index.ts BookPage out/b.mp4 --props='{"seed":1,"linesSvgPath":"lines.svg","colorImagePath":"color.png","bgColor":"#cf8f6c"}'
ffmpeg -i out/a.mp4 -vf "select=eq(n\,30)" -frames:v 1 -f rawvideo -pix_fmt rgb24 - 2>/dev/null | shasum -a 256
ffmpeg -i out/b.mp4 -vf "select=eq(n\,30)" -frames:v 1 -f rawvideo -pix_fmt rgb24 - 2>/dev/null | shasum -a 256
# 两个 hash 应相同
```

---

## 技术栈

- **Remotion** 4.0.290 — React 时间轴 + 无头 Chromium → MP4
- **sharp** 0.33 — 图像 IO、灰度/阈值/采样
- **potrace** 2.1 (纯 JS) — bitmap → SVG path
- **mulberry32** — 32-bit seeded PRNG（自己写在 `src/rng.ts`，~10 行）

---

## 已知局限 / 路线图

1. **线条是轮廓不是中心线**：potrace 给的是形状的边界，所以粗笔触会有"双线描边"。1.2px stroke 下基本看不出，但放大能看见。要根治需要 centerline tracing（OpenCV skeleton 之类，目前没接）。
2. **笔触颜色写死** `#3a2a20`（暖深棕），暂未从图自动取样。
3. **单图 → 单段视频**。多图绘本 + 翻页过渡是下一步。
4. **没有 TTS 旁白 + BGM**。MVP 范围之外。

---

## 一个完整可复现的例子

```bash
git clone <this-repo>
cd storyImgToVideo
npm install

npm run preprocess -- demo_img.jpeg
# → [preprocess] sampled bgColor=#cf8f6c
# → [preprocess] done. 1408x768, 317 paths, bg #cf8f6c

# 用一个固定 seed 渲染，任何机器跑结果都一样
npx remotion render src/index.ts BookPage out/reproducible.mp4 \
  --props='{"seed":1,"linesSvgPath":"lines.svg","colorImagePath":"color.png","bgColor":"#cf8f6c"}'

# 验证元数据
ffprobe -v error -show_entries stream=width,height,duration,r_frame_rate \
  -show_entries format=duration -of default out/reproducible.mp4
# → width=1408
# → height=768
# → r_frame_rate=30/1
# → duration=10.000000
```
