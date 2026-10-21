// 内置示例文档：首启欢迎页 + Mock 实测共用。
// 覆盖渲染器全部能力：标题/表格/代码高亮/列表/任务/GFM Alert/脚注/高亮标记/
// 行内代码/kbd/引用/分隔线/链接/图片/公式/Mermaid 图/本地图片。
export const DEMO_MD = `# JVM 与性能调优：从"背参数"到"讲清楚"

> [!NOTE]
> 这是一份 **mdview 渲染能力示例**。双击任意 \`.md\` 文件即可像这样阅读；
> 标题栏可在「渲染 / 源码 / 对照」之间切换，深浅主题、字号、代码换行与
> .md 文件关联都在右上角 ⚙ 设置里。

## 一、知识点织网（速览）

- **方法论**：调优的顺序不能反——*观察 → 假设 → 验证 → 固化*
- **内存模型**：JVM 进程内存 = \`Xmx\` + 元空间 + 线程栈 + 堆外
- **收集器选型**：==一张表定生死==，见下节
- **G1 深度**：面试最深挖的收集器
- **容器化 JVM**：云上踩坑集中地
- **真实故障与排查复盘**：五分钟定位法

## 二、收集器选型：一张表定生死

| 收集器 | 适合场景 | 停顿目标 | 堆大小 | 版本状态 |
| --- | --- | --- | --- | --- |
| **Serial** | 单核、小内存、客户端 | 不可控 | < 512M | 老古董，别新项目用 |
| **Parallel** | 批处理 / ETL，吞吐优先 | 秒级可接受 | 4GB–8GB | JDK8 默认，仍常见 |
| **CMS** | 老系统维护 | 短但不稳定 | 中堆 | **JDK9 废弃、JDK14 移除——别在新项目提它** |
| **G1** | 通用首选，Web 服务、中等以上堆 | 可控（软目标） | 4GB–32GB+ | **JDK9+ 默认**，生态与工具链最成熟 |
| **ZGC** | P99 延迟敏感，大堆（>8G） | <10ms，且几乎不随堆增大而恶化 | 8GB–16TB | JDK11 实验、JDK15 生产、**JDK 21 分代 ZGC** |
| **Shenandoah** | 类似 ZGC，Red Hat 系，对旧 JDK backport 友好 | <10ms | 大堆 | JDK15 生产 |

**选型决策树：**

1. 堆 < 4G 且无明显延迟要求 → **G1**（省心）。
2. 批处理/ETL/只关心总耗时 → **Parallel**（吞吐最高，GC 开销最低）。
3. P99/P999 有硬 SLA（如网关、交易、实时推荐），堆 ≥ 8G → **ZGC（JDK 21+ 分代）**。
4. 不能升 JDK 但要低延迟 → **Shenandoah**（有 8/11 backport 版本）。
5. ⚠️ 别为了"新技术"上 ZGC：它牺牲了部分吞吐（约 5~15\`%\`）、CPU 占用更高，且小堆（<4G）场景优势不明显。

**重要提醒**：换收集器之前，先确认你的问题是 GC 造成的。如果 P99 毛刺来自下游 RPC 超时或锁竞争，换成 ZGC 毫无作用——这是面试中最常见的"答非所问"。

## 三、容器化 JVM：云上踩坑集中地

\`\`\`yaml
# ✅ 推荐姿势（K8s resources.limits.memory: 8Gi）
resources:
  limits:
    memory: "8Gi"
    cpu: "2"
# JVM 侧
JAVA_OPTS: >
  -XX:+UseContainerSupport
  -XX:InitialRAMPercentage=50.0
  -XX:MaxRAMPercentage=70.0          # 给堆外留 30%
  -XX:MaxMetaspaceSize=256m
  -XX:NativeMemoryTracking=summary
  -Xlog:gc*:file=/logs/gc.log:time,uptime:filecount=5,filesize=50M
  -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/logs/heap.hprof
\`\`\`

**避坑：**

1. 别在容器里写死 \`-Xmx\`：用 \`*RAMPercentage\`，否则迁移 Pod 规格时容易遗忘。
2. **cgroup v1 的内存统计口径问题**：老基础镜像（glibc/老 JDK）可能读不到正确限制 → 升级到较新的 JDK 小版本。
3. **透明大页（THP）**：会导致 ZGC/G1 的延迟毛刺与内存过度占用，低延迟服务建议在宿主机层面禁用 THP（\`echo never > /sys/kernel/mm/transparent_hugepage/enabled\`）。
4. **CPU 限流（throttling）**：cgroup CPU limit 会导致周期性停顿，表现像 GC 停顿但 GC 日志里没有对应记录。判据：\`cat /sys/fs/cgroup/cpu/cpu.stat\` 看 \`nr_throttled\`。
5. **优雅停机**：preStop 睡眠 + 摘流量 + 等待请求排空，避免 SIGKILL 截断正在处理的请求与未刷的 GC 日志。

## 四、快捷键与排版元素

| 操作 | 快捷键 |
| --- | --- |
| 打开目录 | <kbd>Ctrl</kbd> + <kbd>O</kbd> |
| 切换主题 | 右键 → 深色/浅色主题 |
| 关闭窗口 | <kbd>Esc</kbd> 或 <kbd>Ctrl</kbd> + <kbd>W</kbd> |

- [x] 支持 GFM 任务列表
- [x] 支持 ==高亮标记==、**粗体**、*斜体*、~~删除线~~
- [ ] 支持 \`行内代码\` 与脚注[^1]
- [ ] 支持 Wiki 双链：相关笔记见 [[G1 深度]]

[^1]: 脚注会汇总到文末，点击 ↩ 可跳回原处。

### 数学公式

行内公式 $E = mc^2$，块级公式：

$$
\\text{GC 停顿占比} = \\frac{\\sum \\text{Stop-The-World 时间}}{\\text{总运行时间}} \\times 100\\%
$$

### Mermaid 流程图

\`\`\`mermaid
graph LR
  A[观察现象] --> B{是 GC 问题?}
  B -- 是 --> C[选收集器]
  B -- 否 --> D[查锁竞争/RPC]
  C --> E[压测验证]
  E --> F[固化参数]
\`\`\`

### 内嵌 SVG 图形

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" width="520" height="150" viewBox="0 0 520 150">
  <rect width="520" height="150" rx="12" fill="#f3f7ff"/>
  <rect x="30" y="46" width="64" height="78" rx="8" fill="#3474f4" opacity="0.9"/>
  <rect x="114" y="70" width="64" height="54" rx="8" fill="#3474f4" opacity="0.6"/>
  <rect x="198" y="36" width="64" height="88" rx="8" fill="#2b64e6" opacity="0.8"/>
  <rect x="282" y="86" width="64" height="38" rx="8" fill="#2b64e6" opacity="0.5"/>
  <text x="30" y="30" font-family="sans-serif" font-size="14" fill="#1f4fd8">SVG 代码块会被直接渲染成图形</text>
</svg>
\`\`\`

点卡片头部的「源码」按钮可以在图形与原始代码之间切换。

### 本地图片

Markdown 同目录下的图片自动加载（PNG/JPG/SVG/GIF），相对路径直接写：

![示例图片](assets/sample.svg)

---

*mdview — 轻量 Markdown 本地阅读工具 · 示例文档*
`

// 给示例文档配一张内置 SVG 示意图（data URI，模拟"本地图片"渲染链路）。
export const DEMO_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200" viewBox="0 0 640 200"><rect width="640" height="200" rx="12" fill="#f0f6ff"/><rect x="24" y="24" width="120" height="152" rx="8" fill="#dbeafe"/><rect x="40" y="40" width="88" height="10" rx="5" fill="#60a5fa"/><rect x="40" y="60" width="72" height="10" rx="5" fill="#93c5fd"/><rect x="40" y="80" width="80" height="10" rx="5" fill="#93c5fd"/><rect x="184" y="24" width="432" height="152" rx="8" fill="#ffffff" stroke="#bfdbfe"/><polyline points="210,150 260,120 310,132 360,84 410,96 460,60 510,72 560,44" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round"/><circle cx="260" cy="120" r="4" fill="#2563eb"/><circle cx="360" cy="84" r="4" fill="#2563eb"/><circle cx="460" cy="60" r="4" fill="#2563eb"/><circle cx="560" cy="44" r="4" fill="#2563eb"/><text x="210" y="42" font-family="sans-serif" font-size="14" fill="#1d4ed8">GC 停顿趋势（示意）</text></svg>`

// Mock 文件树：镜像截图里的 Obsidian 知识库形态。
export function mockTree(): { name: string; path: string; isDir: boolean; children?: any[] }[] {
  const java = (n: number, title: string) => ({
    name: `${String(n).padStart(2, '0')}-${title}.md`,
    path: `C:\\Users\\wangb\\OneDrive\\Obsidian\\迷你狐的知识库\\01-计算机技术\\编程语言\\Java\\${String(n).padStart(2, '0')}-${title}.md`,
    isDir: false
  })
  const dir = 'C:\\Users\\wangb\\OneDrive\\Obsidian\\迷你狐的知识库\\01-计算机技术\\编程语言\\Java'
  return [
    {
      name: 'Java',
      path: dir,
      isDir: true,
      children: [
        java(1, 'Java语言版本演进'),
        java(2, 'Java基础语法'),
        java(3, 'Java高级语法'),
        java(4, 'Java Collection'),
        java(5, 'Java泛型'),
        java(6, 'JVM 内存模型与 GC'),
        java(7, 'Java 并发编程'),
        java(8, 'Spring 体系'),
        java(9, 'Spring Boot & Spring Cloud'),
        java(10, '数据库与 ORM'),
        java(11, '分布式事务与 Seata'),
        java(12, '数据库分库分表'),
        java(13, '数据库连接池'),
        java(14, 'Java缓存（Redis）'),
        java(15, 'Java消息队列（Kafka、RocketMQ）'),
        java(16, 'JVM 与性能调优'),
        {
          name: '已存档',
          path: `${dir}\\已存档`,
          isDir: true,
          children: [
            java(17, '旧版 JVM 笔记（归档）')
          ]
        }
      ]
    }
  ]
}

export function fileToDir(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

export function fileBase(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}
