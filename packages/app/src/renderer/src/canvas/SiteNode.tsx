/**
 * SiteNode.tsx — Canvas node that renders a labeled field-site region.
 *
 * Displayed behind device nodes (zIndex -1) as a colored, semi-transparent
 * rectangle. Authors use these to mark physical ICS field locations:
 *   - Local sites  (control room, substation)
 *   - Remote sites (pipeline pump station, distant RTU cabinet)
 *
 * Behavior:
 *   Author Mode  — NodeResizer handles allow drag-to-resize; label is editable
 *                  inline (click once to select the node, double-click the label
 *                  to enter edit mode); color picker appears in the header bar.
 *   Student Mode — Region is visible but resize handles and label editing are
 *                  disabled; color picker is hidden.
 *
 * The component receives all mutable callbacks through its node `data` prop so
 * it can update the scenario without needing direct context access.
 */

import { useEffect, useRef, useState } from 'react'
import { NodeResizer, type NodeProps, type Node } from '@xyflow/react'
import type { SiteRegion } from '@otforge/schema'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SiteNodeData {
  /** The SiteRegion config being displayed. */
  region: SiteRegion
  /** When true, editing controls (resize handles, label editor, color picker) are hidden. */
  readOnly: boolean
  /** Called when the author commits a new label (on blur or Enter). */
  onLabelChange: (id: string, label: string) => void
  /** Called when the author picks a new color from the native color input. */
  onColorChange: (id: string, color: string) => void
  /**
   * Called when the author finishes dragging a resize handle.
   * Receives the node's updated position (top-left) and dimensions so ScadaCanvas
   * can persist the new geometry to scenario.visual.siteRegions.
   */
  onResizeEnd: (id: string, x: number, y: number, width: number, height: number) => void
}

export type SiteNodeType = Node<SiteNodeData, 'siteNode'>

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Renders a labeled, colored rectangular field-site region on the SCADA canvas.
 *
 * Uses React Flow's NodeResizer for resize handles (Author Mode only).
 * The label is an inline contentEditable that commits on blur or Enter.
 * The color is changed via a hidden <input type="color"> triggered by the swatch button.
 */
export function SiteNode({ id, data, selected }: NodeProps) {
  const { region, readOnly, onLabelChange, onColorChange, onResizeEnd } = data as SiteNodeData

  const [editing, setEditing] = useState(false)
  const [draftLabel, setDraftLabel] = useState(region.label)
  const labelRef = useRef<HTMLInputElement>(null)
  const colorRef = useRef<HTMLInputElement>(null)

  // Keep draftLabel in sync when region.label changes externally (e.g. undo).
  useEffect(() => {
    setDraftLabel(region.label)
  }, [region.label])

  // Focus the label input immediately when edit mode is entered.
  useEffect(() => {
    if (editing) {
      labelRef.current?.focus()
      labelRef.current?.select()
    }
  }, [editing])

  function commitLabel(): void {
    setEditing(false)
    const trimmed = draftLabel.trim() || region.label
    setDraftLabel(trimmed)
    onLabelChange(id, trimmed)
  }

  function handleLabelKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitLabel()
    }
    if (e.key === 'Escape') {
      setEditing(false)
      setDraftLabel(region.label)
    }
    // Prevent Delete key from deleting the node while typing.
    e.stopPropagation()
  }

  // Derive border and fill colors from the stored color.
  // Border at full opacity; fill at 10% so devices inside are still clearly visible.
  const borderColor = region.color
  const fillColor = `${region.color}1a` // hex + '1a' = 10% opacity

  return (
    <>
      {/* Resize handles — only shown in Author Mode when node is selected */}
      {!readOnly && (
        <NodeResizer
          isVisible={selected}
          minWidth={160}
          minHeight={120}
          lineStyle={{ borderColor, borderWidth: 2 }}
          handleStyle={{ background: borderColor, borderColor: '#0d1117', width: 10, height: 10 }}
          onResizeEnd={(_event, params) =>
            onResizeEnd(id, params.x, params.y, params.width, params.height)
          }
        />
      )}

      {/* Region rectangle */}
      <div
        className={`site-node${selected ? ' site-node--selected' : ''}${readOnly ? ' site-node--readonly' : ''}`}
        style={{
          width: '100%',
          height: '100%',
          borderColor,
          backgroundColor: fillColor
        }}
      >
        {/* Header bar — label + color swatch */}
        <div className="site-node__header" style={{ borderBottomColor: borderColor }}>
          {/* Label — click to edit in Author Mode */}
          {editing && !readOnly ? (
            <input
              ref={labelRef}
              className="site-node__label-input"
              value={draftLabel}
              onChange={e => setDraftLabel(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={handleLabelKeyDown}
            />
          ) : (
            <span
              className="site-node__label"
              onDoubleClick={() => {
                if (!readOnly) setEditing(true)
              }}
              title={readOnly ? undefined : 'Double-click to rename'}
            >
              {region.label}
            </span>
          )}

          {/* Color swatch — clicking opens the native color picker (Author Mode only) */}
          {!readOnly && (
            <button
              className="site-node__color-btn"
              style={{ background: borderColor }}
              title="Change site color"
              onClick={e => {
                e.stopPropagation()
                colorRef.current?.click()
              }}
            >
              {/* Visually hidden native color input */}
              <input
                ref={colorRef}
                type="color"
                className="site-node__color-input"
                value={region.color}
                onChange={e => onColorChange(id, e.target.value)}
              />
            </button>
          )}
        </div>
      </div>
    </>
  )
}
