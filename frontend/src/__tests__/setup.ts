import { vi } from 'vitest'

// mindmap.ts 在模块加载时创建 Ruler 并尝试 getContext('2d')；
// jsdom 未实现 canvas 会向 console 打 "Not implemented" 噪音。
// 返回 null 让 Ruler 走纯文本启发式分支，不影响被测逻辑。
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as typeof HTMLCanvasElement.prototype.getContext
