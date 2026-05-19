/**
 * plc-import.ts — PLC project file parser for the OTForge PLC IDE.
 *
 * Supports three source formats commonly encountered in ICS/SCADA environments:
 *
 *   1. Rockwell Logix Designer L5X (.l5x)
 *      XML export of an RSLogix 5000 / Studio 5000 Logix Designer project.
 *      Only <Routine Type="ST"> elements are extracted; RLL (Ladder) and FBD
 *      routines are skipped with a user-facing warning. Variables come from
 *      <Tag> elements in the enclosing <Program>/<Tags> block. Logix uses
 *      proprietary tag names (not IEC I/O addresses), so address is left empty
 *      and the IDE assigns defaults based on type and column position.
 *
 *   2. PLCopen XML / CODESYS export (.xml, .export)
 *      Vendor-neutral IEC 61131-3 interchange format used by CODESYS, Beckhoff
 *      TwinCAT, OpenPLC Editor, and many others. Extracts <pou> elements with
 *      pouType "program" or "functionBlock". The ST body is inside <ST><xhtml:p>
 *      or <ST><xhtml:body>/<xhtml:p> depending on tool version. Variables come
 *      from <inputVars>, <outputVars>, and <localVars> variable lists.
 *
 *   3. Plain Structured Text / SCL (.st, .scl)
 *      Raw IEC 61131-3 ST source or Siemens SCL. Treated as a single routine.
 *      Variables are extracted from leading VAR...END_VAR blocks via regex;
 *      IEC I/O addresses (%QX0.0, %IW1, etc.) are parsed when present.
 *
 * Public API:
 *   parsePlcFile(filePath: string, fileBuffer: Buffer): PlcImportResult
 *
 * All parsers produce ImportedRoutine objects — the renderer presents a picker
 * modal when more than one routine is found, so the user can choose which to load.
 *
 * Type normalization (Logix → IEC):
 *   BOOL → BOOL, INT/INT8/SINT → INT, DINT/LINT/UINT/UDINT → DINT,
 *   REAL/LREAL → REAL, WORD/DWORD/LWORD → WORD
 *
 * @module plc-import
 */

import type { PlcImportResult, ImportedRoutine, ImportedVariable } from '@otforge/schema'
import path from 'path'

// ── Type normalization ─────────────────────────────────────────────────────────

/**
 * Maps Logix Designer (Rockwell) and other vendor-specific data types to the
 * five IEC 61131-3 types that OpenPLC Runtime natively supports.
 *
 * Unmapped types fall back to "DINT" as the safest integer default — the IDE
 * will still show the variable with its original comment so the user can
 * correct the type manually.
 */
const TYPE_MAP: Record<string, string> = {
  // Booleans
  BOOL: 'BOOL',
  BIT: 'BOOL',
  // 16-bit integers
  INT: 'INT',
  SINT: 'INT',
  INT8: 'INT',
  UINT: 'INT',
  // 32-bit integers (map wide types down to DINT)
  DINT: 'DINT',
  LINT: 'DINT',
  UDINT: 'DINT',
  ULINT: 'DINT',
  // Floats
  REAL: 'REAL',
  LREAL: 'REAL',
  // Words / raw bit patterns
  WORD: 'WORD',
  DWORD: 'WORD',
  LWORD: 'WORD',
  BYTE: 'WORD'
}

/**
 * Normalizes a vendor data type string to one of the five IEC 61131-3 types
 * supported by the OpenPLC Runtime ST compiler.
 *
 * @param raw - The raw type string from the source file (e.g. "LINT", "REAL").
 * @returns A normalized IEC type, or "DINT" if the input is unmapped.
 */
function normalizeType(raw: string): string {
  return TYPE_MAP[raw.toUpperCase()] ?? 'DINT'
}

// ── IEC address inference (for L5X) ───────────────────────────────────────────

/**
 * Generates a default IEC 61131-3 I/O address for a Logix tag that has no
 * native IEC address. The address is intentionally generic — users are expected
 * to review and adjust the variable table in the IDE before deploying.
 *
 * Mapping strategy:
 *   - Tags starting with "i_" or "input"  → %IX{index}.0 (input bit)
 *   - Tags ending   with "_out" or "out"  → %QX{index}.0 (output bit)
 *   - All others                          → %MX{index}.0 (internal marker bit)
 *
 * For non-BOOL types the address uses a word-level suffix (e.g., %IW0).
 *
 * @param name  - Logix tag name.
 * @param type  - Normalized IEC type (used to decide bit vs. word address).
 * @param index - Zero-based index in the variable list — used as the word address.
 * @returns A placeholder IEC address string.
 */
function inferAddress(name: string, type: string, index: number): string {
  const lower = name.toLowerCase()
  const isWord = type !== 'BOOL'
  const suffix = isWord ? `W${index}` : `X${index}.0`

  if (lower.startsWith('i_') || lower.startsWith('input')) return `%I${suffix}`
  if (lower.endsWith('_out') || lower.endsWith('out')) return `%Q${suffix}`
  return `%M${suffix}`
}

// ── Plain ST / SCL parser ─────────────────────────────────────────────────────

/**
 * Parses a plain IEC 61131-3 Structured Text or Siemens SCL source file.
 *
 * Extracts variable declarations from leading VAR...END_VAR blocks. The entire
 * file is treated as one routine named after the file (without extension).
 *
 * Variable extraction regex handles the common forms:
 *   name : TYPE;                     — no address, no comment
 *   name AT %QX0.0 : BOOL;           — with IEC address
 *   name : BOOL; (* comment *)       — with inline comment
 *   name AT %MW1 : INT; (* comment *)
 *
 * @param source   - Full file text.
 * @param fileName - Base name without extension, used as the routine name.
 * @returns A single ImportedRoutine containing the source and extracted variables.
 */
function parseSt(source: string, fileName: string): ImportedRoutine {
  const variables: ImportedVariable[] = []
  const warnings: string[] = []

  // Match every VAR...END_VAR block (case-insensitive; handles VAR_INPUT, VAR_OUTPUT, etc.)
  const varBlockRe =
    /\bVAR(?:_INPUT|_OUTPUT|_IN_OUT|_EXTERNAL|_GLOBAL|_ACCESS)?\b([\s\S]*?)\bEND_VAR\b/gi
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = varBlockRe.exec(source)) !== null) {
    const block = blockMatch[1]
    // Each variable declaration: name [AT address] : TYPE [ASSIGN init] [(*comment*)]
    const lineRe =
      /(\w+)\s*(?:AT\s*(%[A-Z]+\d+(?:\.\d+)?))?\s*:\s*(\w+)[^;]*;(?:\s*\(\*([^*]*)\*\))?/gi
    let lineMatch: RegExpExecArray | null
    while ((lineMatch = lineRe.exec(block)) !== null) {
      const [, name, address, rawType, comment] = lineMatch
      variables.push({
        name: name.trim(),
        type: normalizeType(rawType),
        address: (address ?? '').trim(),
        comment: (comment ?? '').trim()
      })
    }
  }

  if (variables.length === 0) {
    warnings.push(
      'No VAR...END_VAR blocks found — variable table is empty. Add variables manually.'
    )
  }

  return {
    name: fileName,
    source,
    variables,
    sourceFormat: 'st',
    warnings
  }
}

// ── L5X (Logix Designer) parser ───────────────────────────────────────────────

/**
 * Parses a Rockwell Studio 5000 / RSLogix 5000 L5X XML export file.
 *
 * Searches for <Routine Type="ST"> elements and extracts their line-by-line
 * ST source text from child <Line Text="..."/> or <STContent> elements.
 * RLL and FBD routines are recorded as warnings so the user is informed that
 * they were skipped — the IDE only supports Structured Text.
 *
 * Tag variables come from the enclosing <Program><Tags> block. Because Logix
 * uses symbolic addressing (not IEC I/O addresses), `inferAddress()` is used
 * to generate placeholder %Ix/%Qx/%Mx addresses based on naming conventions.
 *
 * @param xmlText  - Raw XML string from the .l5x file.
 * @param fileName - Base file name for display in the import status message.
 * @returns PlcImportResult with one ImportedRoutine per ST routine found.
 */
function parseL5x(xmlText: string, fileName: string): PlcImportResult {
  const routines: ImportedRoutine[] = []
  const globalWarnings: string[] = []

  // ── Extract program-scope tags (variables) ─────────────────────────────────
  // <Tags> block sits inside the first <Program> element. Grab all <Tag> elements.
  const programTagsBlock = xmlText.match(/<Program\b[^>]*>([\s\S]*?)<\/Program>/i)?.[1] ?? ''
  const tagsBlock = programTagsBlock.match(/<Tags\b[^>]*>([\s\S]*?)<\/Tags>/i)?.[1] ?? ''

  const tagRe = /<Tag\s+Name="([^"]+)"[^>]*DataType="([^"]+)"[^>]*(?:Comment="([^"]*)")?[^/]*\/>/gi
  const allTags: ImportedVariable[] = []
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = tagRe.exec(tagsBlock)) !== null) {
    const [, name, rawType, comment] = tagMatch
    allTags.push({
      name: name.trim(),
      type: normalizeType(rawType),
      address: '',
      comment: (comment ?? '').trim()
    })
  }

  // Also pick up tags with Description child elements (common in L5X exports)
  const tagFullRe = /<Tag\s+Name="([^"]+)"[^>]*DataType="([^"]+)"[^>]*>([\s\S]*?)<\/Tag>/gi
  while ((tagMatch = tagFullRe.exec(tagsBlock)) !== null) {
    const [, name, rawType, inner] = tagMatch
    if (allTags.find(t => t.name === name)) continue // already captured
    const desc = inner.match(/<Description>\s*<!\[CDATA\[([\s\S]*?)\]\]>/i)?.[1]?.trim() ?? ''
    allTags.push({
      name: name.trim(),
      type: normalizeType(rawType),
      address: '',
      comment: desc
    })
  }

  // Assign inferred IEC addresses for the IDE's variable table
  allTags.forEach((t, i) => {
    if (!t.address) t.address = inferAddress(t.name, t.type, i)
  })

  if (allTags.length === 0) {
    globalWarnings.push(
      'No program-scope <Tag> elements found in the L5X file. ' +
        'Variable table will be empty — add variables manually.'
    )
  }

  // ── Extract routines ───────────────────────────────────────────────────────
  // Iterate over all <Routine> elements in the file
  const routineRe = /<Routine\s+Name="([^"]+)"\s+Type="([^"]+)"[^>]*>([\s\S]*?)<\/Routine>/gi
  let rMatch: RegExpExecArray | null
  while ((rMatch = routineRe.exec(xmlText)) !== null) {
    const [, routineName, routineType, routineBody] = rMatch

    if (routineType.toUpperCase() !== 'ST') {
      // Ladder (RLL), FBD, SFC — cannot be imported; warn the user
      globalWarnings.push(
        `Routine "${routineName}" (type: ${routineType}) was skipped — ` +
          'only Structured Text (ST) routines can be imported.'
      )
      continue
    }

    // ST source is stored as individual <Line Text="..."/> elements
    // Some exports use <STContent><![CDATA[...]]></STContent> instead
    let stSource = ''

    const cdataBlock = routineBody.match(/<STContent[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>/i)?.[1]
    if (cdataBlock) {
      stSource = cdataBlock.trim()
    } else {
      // Collect individual <Line Text="..."/> elements in order
      const lineRe2 = /<Line\s+Number="\d+"[^>]*Text="([^"]*)"/gi
      const lines: string[] = []
      let lMatch: RegExpExecArray | null
      while ((lMatch = lineRe2.exec(routineBody)) !== null) {
        // L5X XML-encodes ampersands and angle brackets inside the Text attribute
        lines.push(
          lMatch[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
        )
      }
      stSource = lines.join('\n')
    }

    if (!stSource.trim()) {
      globalWarnings.push(
        `Routine "${routineName}" has no extractable ST source — it may be empty in the L5X export.`
      )
      continue
    }

    routines.push({
      name: routineName,
      source: stSource,
      variables: allTags, // share the same tag list across all ST routines
      sourceFormat: 'l5x-st',
      warnings: globalWarnings.length > 0 ? [...globalWarnings] : []
    })
  }

  if (routines.length === 0) {
    return {
      ok: false,
      error:
        'No Structured Text routines found in this L5X file. ' +
        'The project may contain only Ladder or FBD routines, which cannot be imported. ' +
        (globalWarnings.length > 0 ? globalWarnings.join(' ') : '')
    }
  }

  return { ok: true, routines, fileName }
}

// ── PLCopen XML parser ────────────────────────────────────────────────────────

/**
 * Parses a PLCopen XML interchange file (.xml, .export) produced by CODESYS,
 * Beckhoff TwinCAT, OpenPLC Editor, or any IEC 61131-3 compliant tool.
 *
 * Each <pou> element with pouType="program" or pouType="functionBlock" is
 * treated as one importable routine. The ST body lives inside:
 *   <body><ST><xhtml:p>...</xhtml:p></ST></body>
 * Some tools write it as plain text or use a <![CDATA[...]]> section.
 *
 * Variables are extracted from <inputVars>, <outputVars>, and <localVars>
 * variable lists. Each <variable name="..."> element contains a <type> child
 * (with the IEC type) and optionally a <documentation> child (comment) and an
 * <address> child (IEC I/O address like %QX0.0).
 *
 * @param xmlText  - Raw XML string from the PLCopen file.
 * @param fileName - Base file name shown in the import status message.
 * @returns PlcImportResult with one ImportedRoutine per program/function block found.
 */
function parsePlcopen(xmlText: string, fileName: string): PlcImportResult {
  const routines: ImportedRoutine[] = []

  // Match all <pou> elements (case-sensitive per the PLCopen schema)
  const pouRe = /<pou\s+name="([^"]+)"\s+pouType="([^"]+)"[^>]*>([\s\S]*?)<\/pou>/gi
  let pouMatch: RegExpExecArray | null

  while ((pouMatch = pouRe.exec(xmlText)) !== null) {
    const [, pouName, pouType, pouBody] = pouMatch

    // Only import program and functionBlock; skip function (no persistent state)
    if (pouType !== 'program' && pouType !== 'functionBlock') continue

    // ── Extract ST body ──────────────────────────────────────────────────────
    // Try CDATA section first (most exporters use this to avoid XML escaping)
    let stSource = pouBody.match(/<ST[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>/i)?.[1]?.trim() ?? ''

    if (!stSource) {
      // Fall back to stripping xhtml:p tags and joining text content
      const stBlock = pouBody.match(/<ST[^>]*>([\s\S]*?)<\/ST>/i)?.[1] ?? ''
      stSource = stBlock
        .replace(/<xhtml:p[^>]*>/gi, '')
        .replace(/<\/xhtml:p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim()
    }

    if (!stSource) continue

    // ── Extract variables ────────────────────────────────────────────────────
    const variables: ImportedVariable[] = []

    // Collect from all variable list sections
    const varSectionRe =
      /<(?:inputVars|outputVars|localVars|inOutVars)\s*>([\s\S]*?)<\/(?:inputVars|outputVars|localVars|inOutVars)>/gi
    let sectionMatch: RegExpExecArray | null

    while ((sectionMatch = varSectionRe.exec(pouBody)) !== null) {
      const section = sectionMatch[1]
      // Each <variable name="...">...<type><BOOL/>...</type>...</variable>
      const varRe = /<variable\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/variable>/gi
      let varMatch: RegExpExecArray | null

      while ((varMatch = varRe.exec(section)) !== null) {
        const [, varName, varBody] = varMatch

        // Type: first element inside <type> (may be <BOOL/>, <INT/>, etc.)
        const rawType = varBody.match(/<type[^>]*>\s*<([A-Z]+)/i)?.[1]?.trim() ?? 'DINT'

        // Address: content of <address> element if present
        const address = varBody.match(/<address[^>]*>(.*?)<\/address>/i)?.[1]?.trim() ?? ''

        // Comment: text inside <documentation> → <xhtml:p> (strip tags)
        const docBlock =
          varBody.match(/<documentation[^>]*>([\s\S]*?)<\/documentation>/i)?.[1] ?? ''
        const comment = docBlock
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .trim()

        variables.push({
          name: varName.trim(),
          type: normalizeType(rawType),
          address,
          comment
        })
      }
    }

    routines.push({
      name: pouName,
      source: stSource,
      variables,
      sourceFormat: 'plcopen-st',
      warnings: []
    })
  }

  if (routines.length === 0) {
    return {
      ok: false,
      error:
        'No importable POUs found in this PLCopen XML file. ' +
        'Make sure the file contains at least one <pou> with pouType="program" or pouType="functionBlock" and a Structured Text body.'
    }
  }

  return { ok: true, routines, fileName }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Detects the format of a PLC project file and dispatches to the appropriate
 * parser. Returns a PlcImportResult containing all importable ST routines found.
 *
 * Format detection is based on file extension and, for XML files, a quick
 * text probe of the content:
 *   - .l5x                      → L5X (Logix Designer)
 *   - .xml / .export + <pou     → PLCopen XML
 *   - .xml / .export + <Routine → L5X (occasionally saved with .xml extension)
 *   - .st / .scl                → Plain Structured Text / Siemens SCL
 *
 * @param filePath   - Absolute path to the source file (used for extension and name).
 * @param fileBuffer - Raw file contents as a Node.js Buffer.
 * @returns PlcImportResult — check `.ok` before accessing `.routines`.
 */
export function parsePlcFile(filePath: string, fileBuffer: Buffer): PlcImportResult {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath, path.extname(filePath))
  const text = fileBuffer.toString('utf-8')

  try {
    if (ext === '.l5x') {
      return parseL5x(text, fileName)
    }

    if (ext === '.st' || ext === '.scl') {
      const routine = parseSt(text, fileName)
      return { ok: true, routines: [routine], fileName }
    }

    if (ext === '.xml' || ext === '.export') {
      // Distinguish L5X (saved as .xml) from PLCopen XML by content probe
      if (text.includes('<RSLogix5000Content') || text.includes('<Routine')) {
        return parseL5x(text, fileName)
      }
      // Check for PLCopen root element names used by CODESYS / TwinCAT / OpenPLC Editor
      if (text.includes('<project') || text.includes('<pou')) {
        return parsePlcopen(text, fileName)
      }
      // XML file with unrecognised schema — try PLCopen as a last resort
      return parsePlcopen(text, fileName)
    }

    return {
      ok: false,
      error:
        `Unsupported file type "${ext}". ` +
        'Supported formats: .l5x (Logix Designer), .xml / .export (PLCopen / CODESYS), .st / .scl (plain Structured Text).'
    }
  } catch (err) {
    return {
      ok: false,
      error: `Parse error: ${(err as Error).message}`
    }
  }
}
