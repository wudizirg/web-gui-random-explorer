"""Generate PDF directly from PPTX content using fpdf2"""
import os, sys

# Install fpdf2 if needed
try:
    from fpdf import FPDF
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "fpdf2", "-q"])
    from fpdf import FPDF

# ── Find a Chinese-capable font ──
CN_FONT_PATHS = [
    "C:/Windows/Fonts/msyh.ttc",       # Microsoft YaHei
    "C:/Windows/Fonts/msyhbd.ttc",     # Microsoft YaHei Bold
    "C:/Windows/Fonts/simhei.ttf",     # SimHei
    "C:/Windows/Fonts/simsun.ttc",     # SimSun
    "C:/Windows/Fonts/simkai.ttf",     # KaiTi
]

CN_FONT = None
for fp in CN_FONT_PATHS:
    if os.path.exists(fp):
        CN_FONT = fp
        break

if not CN_FONT:
    print("ERROR: No Chinese font found. Tried:", CN_FONT_PATHS)
    sys.exit(1)

print(f"Using font: {CN_FONT}")

# Register fonts
from fpdf import FPDF

class PDF(FPDF):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.add_font("CJK", "", CN_FONT, uni=True)
        self.add_font("CJK", "B", CN_FONT, uni=True)  # same file for bold

    def set_cjk(self, bold=False):
        style = "B" if bold else ""
        self.set_font("CJK", style, self.font_size)

# ── Config ──
W, H = 420, 238  # A4 landscape in mm, ~16:9 ratio
MARGIN = 15
CONTENT_W = W - 2 * MARGIN

pdf = PDF(orientation="L", unit="mm", format=(W, H))
pdf.set_auto_page_break(False)

# ── Color scheme ──
C_PRIMARY = (26, 86, 219)
C_SECONDARY = (16, 185, 129)
C_ACCENT = (245, 158, 11)
C_DARK = (30, 41, 59)
C_LIGHT = (248, 250, 252)
C_WHITE = (255, 255, 255)
C_GRAY = (100, 116, 139)
C_RED = (239, 68, 68)
C_CODE_BG = (30, 30, 46)
C_PURPLE = (139, 92, 246)

def add_slide(bg=C_LIGHT):
    pdf.add_page()
    pdf.set_fill_color(*bg)
    pdf.rect(0, 0, W, H, "F")

def add_header(text, color=C_PRIMARY):
    pdf.set_fill_color(*color)
    pdf.rect(0, 0, W, 14, "F")
    pdf.set_text_color(*C_WHITE)
    pdf.set_font("CJK", "B", 18)
    pdf.set_xy(MARGIN, 2)
    pdf.cell(CONTENT_W, 10, text, align="L")

def add_title(text, x=None, y=None, size=16, color=C_DARK, bold=True):
    pdf.set_text_color(*color)
    style = "B" if bold else ""
    pdf.set_font("CJK", style, size)
    px = x if x else MARGIN
    py = y if y else pdf.get_y() + 2
    pdf.set_xy(px, py)
    pdf.cell(CONTENT_W, 8, text)

def add_bullet(items, x=None, y=None, size=10, color=C_DARK, spacing=5):
    pdf.set_text_color(*color)
    pdf.set_font("CJK", "B", size)
    px = x if x else MARGIN
    py = y if y else pdf.get_y() + 3
    for item in items:
        pdf.set_xy(px, py)
        pdf.cell(CONTENT_W - 5, spacing, f"  •  {item}")
        py += spacing

def add_code_block(text, x=None, y=None, size=8, w=None, h=None):
    px = x if x else MARGIN
    py = y if y else pdf.get_y() + 3
    bw = w if w else CONTENT_W
    bh = h if h else 50
    pdf.set_fill_color(*C_CODE_BG)
    pdf.rect(px, py, bw, bh, "F")
    pdf.set_text_color(166, 226, 46)
    pdf.set_font("CJK", "", size)
    pdf.set_xy(px + 2, py + 2)
    lines = text.split("\n")
    for line in lines:
        pdf.cell(bw - 4, 4, line[:100])
        pdf.set_xy(px + 2, pdf.get_y() + 3.5)

def add_table(headers, rows, x=None, y=None, col_widths=None, font_size=8):
    px = x if x else MARGIN
    py = y if y else pdf.get_y() + 2
    if not col_widths:
        col_widths = [CONTENT_W / len(headers)] * len(headers)
    # Header
    pdf.set_fill_color(*C_PRIMARY)
    pdf.set_text_color(*C_WHITE)
    pdf.set_font("CJK", "B", font_size)
    for i, (h, cw) in enumerate(zip(headers, col_widths)):
        pdf.set_xy(px + sum(col_widths[:i]), py)
        pdf.cell(cw, 6, h, border=0, fill=True, align="C")
    # Rows
    for ri, row in enumerate(rows):
        row_y = py + 6 + ri * 5
        bg = (241, 245, 249) if ri % 2 == 0 else C_WHITE
        pdf.set_fill_color(*bg)
        pdf.set_text_color(*C_DARK)
        pdf.set_font("CJK", "", font_size - 1)
        for i, (cell, cw) in enumerate(zip(row, col_widths)):
            pdf.set_xy(px + sum(col_widths[:i]), row_y)
            text_color = C_DARK
            if "✅" in cell: text_color = C_SECONDARY
            elif "❌" in cell: text_color = C_RED
            pdf.set_text_color(*text_color)
            pdf.cell(cw, 5, cell, border=0, fill=True, align="C" if i > 0 else "L")

def add_circle(x, y, r, color, text=""):
    pdf.set_fill_color(*color)
    pdf.set_text_color(*C_WHITE)
    pdf.set_font("CJK", "", 9)
    # fpdf2 doesn't have circle, use a small rect for now
    pdf.rect(x, y, r * 2, r * 2, "F")
    pdf.set_xy(x, y)
    pdf.cell(r * 2, r * 2, text, align="C")

# ═══════════════════════════════════════════
# Slide 1: Cover
# ═══════════════════════════════════════════
add_slide(C_DARK)
pdf.set_fill_color(*C_PRIMARY)
pdf.rect(0, 0, W, 1.5, "F")
pdf.rect(0, H - 1.5, W, 1.5, "F")
pdf.set_text_color(*C_WHITE)
pdf.set_font("CJK", "B", 28)
pdf.set_xy(MARGIN + 10, 45)
pdf.cell(CONTENT_W - 20, 14, "Web GUI 自动化探索测试工具")
pdf.set_text_color(*C_SECONDARY)
pdf.set_font("CJK", "", 18)
pdf.set_xy(MARGIN + 10, 62)
pdf.cell(CONTENT_W - 20, 10, "Abtext — 软件测试导论 期末大作业 完善方案")
pdf.set_fill_color(*C_SECONDARY)
pdf.rect(MARGIN + 10, 75, 60, 1, "F")

items = [
    "方向一：增加页面状态抽象与表单结构感知",
    "方向二：接入大模型，生成更聪明的点击/输入序列",
    "方向三：增加截图、DOM 快照、异常检测与回溯",
]
add_bullet(items, MARGIN + 10, 82, size=12, color=(148, 163, 184), spacing=6)
pdf.set_text_color(*C_GRAY)
pdf.set_font("CJK", "", 10)
pdf.set_xy(MARGIN + 10, H - 25)
pdf.cell(CONTENT_W, 5, "2026年6月  |  TypeScript + Playwright + LLM")

# ═══════════════════════════════════════════
# Slide 2: TOC
# ═══════════════════════════════════════════
add_slide()
add_header("📋  目  录")
toc = [
    ("01", "项目背景与现状分析", "了解 Abtext 的当前架构与能力边界"),
    ("02", "方向一：页面状态抽象与表单感知", "FSM 状态机 + 表单结构解析"),
    ("03", "方向二：大模型智能策略增强", "LLM 多步规划 + 状态感知 Prompt"),
    ("04", "方向三：截图/DOM快照/异常检测/回溯", "全链路监控与故障恢复"),
    ("05", "整体架构设计", "新模块关系图与数据流"),
    ("06", "实施计划与产出", "10步实施路线 + 预期成果"),
    ("07", "修改前后详细对比", "文件结构、代码量、能力维度"),
    ("08", "实际完成情况", "三个方向的具体实现成果"),
    ("09", "后续完善与展望", "短/中/长期优化路线图"),
]
for i, (num, title, desc) in enumerate(toc):
    y = 20 + i * 20
    pdf.set_text_color(*C_PRIMARY)
    pdf.set_font("CJK", "B", 16)
    pdf.set_xy(MARGIN + 5, y)
    pdf.cell(12, 7, num)
    pdf.set_text_color(*C_DARK)
    pdf.set_font("CJK", "", 14)
    pdf.set_xy(MARGIN + 20, y)
    pdf.cell(150, 7, title)
    pdf.set_text_color(*C_GRAY)
    pdf.set_font("CJK", "", 10)
    pdf.set_xy(MARGIN + 20, y + 7)
    pdf.cell(150, 5, desc)

# ═══════════════════════════════════════════
# Slide 3: Before/After Comparison
# ═══════════════════════════════════════════
add_slide()
add_header("07  修改前后详细对比")
add_title("📁 修改前（3 个源文件）", MARGIN, 20, 14, C_RED)
add_code_block("src/\n├── cli.ts          (74 行)\n├── explorer.ts     (380 行)\n└── types.ts        (67 行)\n\n总计: 3 文件, ~520 行",
               MARGIN, 28, 8, 130, 35)

add_title("📁 修改后（9 个源文件）", MARGIN + 195, 20, 14, C_SECONDARY)
add_code_block("src/\n├── cli.ts              [修改] 80 行\n├── explorer.ts         [修改] 550 行\n├── types.ts            [修改] 195 行\n├── state-machine.ts    [新增]\n├── form-analyzer.ts    [新增]\n├── llm-strategist.ts   [新增]\n├── dom-snapshot.ts     [新增]\n├── anomaly-detector.ts [新增]\n└── backtracker.ts      [新增]\n\n总计: 9 文件, ~2000 行",
               MARGIN + 195, 28, 8, 130, 35)

add_title("📊 能力维度对比", MARGIN, 68, 14, C_PRIMARY)
add_table(
    ["能力维度", "修改前", "修改后"],
    [
        ["页面状态感知", "❌ 无", "✅ FSM 8 种状态分类"],
        ["表单结构理解", "❌ 仅枚举 input", "✅ label 关联/required/类型推断"],
        ["LLM Prompt", "基础元素列表", "✅ 状态+表单+进度+异常"],
        ["DOM 持久化", "❌ 仅内存", "✅ 每步 JSON + diff"],
        ["异常检测", "❌ 无", "✅ 6类异常实时检测"],
        ["故障恢复", "❌ 出错即停止", "✅ 自动回溯 goBack"],
        ["CLI 可控性", "5 个参数", "✅ 9 个参数"],
    ],
    MARGIN, 76,
    [70, 80, 80],
    font_size=9,
)

# ═══════════════════════════════════════════
# Slide 4: Actual Completion
# ═══════════════════════════════════════════
add_slide()
add_header("08  实际完成情况", C_SECONDARY)

modules = [
    ("方向一: 页面状态抽象与表单感知", C_SECONDARY, [
        "✅ state-machine.ts: 指纹计算 + 8状态分类 + 转移记录",
        "✅ form-analyzer.ts: <form>解析 + label关联 + required检测",
        "✅ types.ts: 新增12个类型定义",
        "✅ explorer.ts集成: 每步指纹计算、状态分类、转移记录",
    ]),
    ("方向二: LLM智能策略增强", C_ACCENT, [
        "✅ llm-strategist.ts: buildSystemPrompt + buildUserPrompt",
        "✅ Prompt增强: 表单结构表格、填充进度、状态感知",
        "✅ 异常感知: 异常摘要注入prompt辅助LLM决策",
    ]),
    ("方向三: 截图/DOM快照/异常/回溯", C_PURPLE, [
        "✅ dom-snapshot.ts: 简化DOM树→JSON + step diff",
        "✅ anomaly-detector.ts: 6类异常监听 + 严重程度判断",
        "✅ backtracker.ts: 快照栈 + goBack/导航 + 次数限制",
        "✅ explorer.ts集成: 每步快照→检测→严重异常触发回溯",
    ]),
]

for i, (title, color, items) in enumerate(modules):
    y = 20 + i * 55
    pdf.set_fill_color(*color)
    pdf.rect(MARGIN, y, CONTENT_W, 8, "F")
    pdf.set_text_color(*C_WHITE)
    pdf.set_font("CJK", "B", 11)
    pdf.set_xy(MARGIN + 2, y + 1)
    pdf.cell(CONTENT_W - 4, 5, title)
    add_bullet(items, MARGIN + 2, y + 10, size=9, spacing=4)

pdf.set_draw_color(*C_PRIMARY)
pdf.line(MARGIN, 185, W - MARGIN, 185)
stats = [
    "✅ TypeScript 编译: 零错误通过 (tsc --noEmit)",
    "✅ 9 个 .js 文件成功生成到 dist/",
    "✅ 向下兼容: 所有原有参数和默认行为保持不变",
]
add_bullet(stats, MARGIN, 188, size=10, spacing=5)

# ═══════════════════════════════════════════
# Slide 5: Future Roadmap
# ═══════════════════════════════════════════
add_slide()
add_header("09  后续完善与展望", C_ACCENT)

future = [
    ("🔬 短期（1-2周）", C_SECONDARY, [
        "状态转移图可视化: Mermaid/Graphviz 输出",
        "HTML 报告生成: 截图+快照+日志整合",
        "表单填充策略库: 预设登录/注册/搜索模板",
        "A/B 对比: 多次运行状态覆盖率对比",
    ]),
    ("🚀 中期（1-2月）", C_ACCENT, [
        "覆盖率指标: 状态/字段/路径覆盖率",
        "并发探索: 多浏览器实例并行",
        "断言系统: 用户定义预期转移路径",
        "Replay 回放: 基于DOM快照离线回放",
    ]),
    ("🌟 长期（3-6月）", C_PURPLE, [
        "强化学习探索: RL替代LLM+随机策略",
        "视觉回归测试: 截图对比检测UI变更",
        "CI/CD 集成: GitHub Actions / Jenkins",
        "自然语言测试: 描述需求自动生成计划",
    ]),
]

for i, (title, color, items) in enumerate(future):
    x = MARGIN + i * 135
    pdf.set_fill_color(*color)
    pdf.rect(x, 20, 128, 8, "F")
    pdf.set_text_color(*C_WHITE)
    pdf.set_font("CJK", "B", 11)
    pdf.set_xy(x + 2, 21)
    pdf.cell(124, 5, title)
    add_bullet(items, x + 2, 30, size=9, spacing=5)

# ═══════════════════════════════════════════
# Slide 6: Architecture
# ═══════════════════════════════════════════
add_slide()
add_header("05  整体架构设计")
add_code_block(
    "                    ┌──────────────────┐\n"
    "                    │     cli.ts       │\n"
    "                    │  CLI入口&参数解析 │\n"
    "                    └────────┬─────────┘\n"
    "                             │\n"
    "                    ┌────────▼─────────┐\n"
    "                    │   explorer.ts    │\n"
    "                    │   核心探索引擎    │\n"
    "                    └──┬───┬───┬───┬──┘\n"
    "           ┌───────────┘   │   │   └──────────┐\n"
    "  ┌────────▼──────┐ ┌──────▼───▼───▼───┐ ┌────▼──────────┐\n"
    "  │state-machine  │ │ llm-strategist   │ │  backtracker  │\n"
    "  │   .ts         │ │     .ts          │ │     .ts       │\n"
    "  │  页面状态机   │ │  增强LLM策略层   │ │  状态回溯管理  │\n"
    "  └───────┬───────┘ └───────┬──────────┘ └───────┬────────┘\n"
    "          │          ┌──────▼──────┐             │\n"
    "  ┌───────▼──────┐   │  callLlm()  │    ┌────────▼────────┐\n"
    "  │form-analyzer │   │ (已有,增强) │    │anomaly-detector │\n"
    "  │    .ts       │   └────────────┘    │     .ts         │\n"
    "  │ 表单结构解析 │                     │  异常检测器     │\n"
    "  └─────────────┘                     └────────┬────────┘\n"
    "                                               │\n"
    "                                      ┌────────▼────────┐\n"
    "                                      │  dom-snapshot   │\n"
    "                                      │     .ts         │\n"
    "                                      │  DOM 快照捕获   │\n"
    "                                      └─────────────────┘",
    MARGIN, 20, 10, 170, 35,
)

# ═══════════════════════════════════════════
# Slide 7: Tech Highlights
# ═══════════════════════════════════════════
add_slide(C_DARK)
pdf.set_fill_color(*C_ACCENT)
pdf.rect(0, 0, W, 1.5, "F")
pdf.rect(0, H - 1.5, W, 1.5, "F")
pdf.set_text_color(*C_WHITE)
pdf.set_font("CJK", "B", 24)
pdf.set_xy(MARGIN + 10, 20)
pdf.cell(CONTENT_W, 12, "✨ 技术亮点总结")

highlights = [
    ("🎯 页面指纹算法", "URL路径 + 表单签名hash + 关键元素文本hash，精确识别页面状态"),
    ("🧩 模块化架构", "6个独立模块，职责清晰，可单独测试，可插拔启用/禁用"),
    ("🔄 异常闭环", "检测 → 记录 → 回溯 → 恢复 → 继续，形成完整容错链路"),
    ("🧠 LLM上下文增强", "Markdown表格输出表单结构、进度追踪、异常感知"),
    ("📸 全链路可追溯", "截图 + DOM JSON + 日志 + 状态转移，事后可完整复盘"),
    ("🛡️ 向下兼容", "所有新功能默认启用但可关闭，原有API和参数完全保留"),
]

for i, (icon, desc) in enumerate(highlights):
    y = 42 + i * 25
    pdf.set_text_color(*C_ACCENT)
    pdf.set_font("CJK", "B", 16)
    pdf.set_xy(MARGIN + 10, y)
    pdf.cell(20, 8, icon)
    pdf.set_text_color(*C_WHITE)
    pdf.set_font("CJK", "", 12)
    pdf.set_xy(MARGIN + 35, y + 1)
    pdf.cell(180, 6, desc)

pdf.set_draw_color(*C_ACCENT)
pdf.line(MARGIN + 10, H - 40, W - MARGIN - 10, H - 40)
pdf.set_text_color(*C_WHITE)
pdf.set_font("CJK", "B", 16)
pdf.set_xy(MARGIN + 10, H - 35)
pdf.cell(CONTENT_W - 20, 10, "从「随机盲探」到「智能感知」—— Web GUI 自动测试工具的质变升级", align="C")

# ── Save ──
output_dir = os.path.dirname(os.path.abspath(__file__))
output_path = os.path.join(os.path.dirname(output_dir), "完善方案讲解.pdf")
pdf.output(output_path)
size_kb = os.path.getsize(output_path) / 1024
print(f"✅ PDF 已生成: {output_path} ({size_kb:.0f} KB)")
