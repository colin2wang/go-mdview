/**
 * Status bar data. Both the source pane (including the edit draft) and the
 * rendered body belong to Viewer, which writes here; StatusBar only reads.
 */
import { reactive } from 'vue'

export const status = reactive({
  hasFile: false,
  editing: false,
  /** Source pane character count (draft while editing) */
  chars: 0,
  /** Visible character count of the rendered body */
  previewChars: 0,
  /** Source pane line count */
  lines: 0,
  /** Cursor position (1-based, meaningful only while editing) */
  caretLine: 0,
  caretCol: 0,
  /** Left summary: encoding / file kind etc. */
  summary: ''
})
