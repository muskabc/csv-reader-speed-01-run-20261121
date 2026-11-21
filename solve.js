// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers as the reference, bit for bit: {columns, rows, errors} for
// every {text, header}. The reference walks the text one character at a time
// and builds every field by concatenation; this one reads each record in
// runs. A run is a stretch of unquoted fields: it is cut out of the line
// with one slice and split on commas in one C-level pass, so the common
// path does no per-field work at all -- no indexOf per field, no object
// per field, no string built up a character at a time. Only the rare bits
// pay for a closer look: a field that opens with a quote, a lone CR, and
// the junk after a closing quote. The line is sliced once per run, so every
// scan inside a run is bounded by the line's length and never runs away to
// the end of the text looking for a delimiter that is not there.
//
// Policy (the reference's, exactly):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, each CRLF or lone CR inside it reads as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on, counting every LF, CRLF and lone CR inside
//     quotes, and row its record's index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Shared patterns (String.replace resets a global regex's lastIndex, so
// these are safe to reuse across calls).
const DOUBLED_QUOTE = /""/g;
const CR_TO_LF = /\r\n|\r/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Count the line breaks in one quoted field's segment: one per LF, one
  // per CRLF, one per lone CR. It runs on the segment itself, so its scans
  // are bounded by the segment's length and never run away down the text
  // looking for a CR that is not there. A segment with no breaks has no CR
  // in it either, so the caller can skip the CR rewrite when this is 0.
  function countBreaks(seg) {
    let c = 0;
    let i = 0;
    for (;;) {
      const j = seg.indexOf('\n', i);
      if (j === -1) break;
      c += 1;
      i = j + 1;
    }
    i = 0;
    for (;;) {
      const j = seg.indexOf('\r', i);
      if (j === -1) break;
      // A CR that is part of a CRLF was already counted with its LF.
      if (seg.charCodeAt(j + 1) !== 10) c += 1;
      i = j + 1;
    }
    return c;
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept. Only used for the
  // rare paths (a lone CR in the way, the junk after a closing quote, a
  // quote that never closes); the common path never calls this.
  function readUnquoted(value) {
    let added = 0;
    let parts = null; // segments, only when a stray CR splits the field
    let start = pos;
    for (;;) {
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      let end = n;
      let kind = END;
      if (comma !== -1 && comma < end) { end = comma; kind = COMMA; }
      if (lf !== -1 && lf < end) { end = lf; kind = LINE_BREAK; }
      if (cr !== -1 && cr < end) { end = cr; kind = 3; } // CR
      if (kind === 3) {
        if (text.charCodeAt(end + 1) === 10) {
          // CRLF ends the record.
          if (parts === null) value += text.slice(start, end);
          else { parts.push(text.slice(start, end)); value = parts.join(''); }
          added += end - start;
          pos = end + 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        // Lone CR: dropped, and the field goes on after it.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [value];
        parts.push(text.slice(start, end));
        added += end - start;
        pos = end + 1;
        start = pos;
        continue;
      }
      if (parts === null) value += text.slice(start, end);
      else { parts.push(text.slice(start, end)); value = parts.join(''); }
      added += end - start;
      if (kind === COMMA) { pos = end + 1; return { value, ended: COMMA, added }; }
      if (kind === LINE_BREAK) { pos = end + 1; line += 1; return { value, ended: LINE_BREAK, added }; }
      pos = end;
      return { value, ended: END, added };
    }
  }

  // Reads a quoted field whose opening quote is at pos. The closing quote
  // is found first without cutting anything; the whole content is then cut
  // once, and doubled quotes and CRs are rewritten with one replace each,
  // only when they are actually there.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let scan = pos + 1;
    let doubled = false;
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', scan);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        doubled = true;
        scan = q + 2;
        continue;
      }
      close = q;
      break;
    }
    const content = text.slice(open + 1, close);
    const br = countBreaks(content);
    line += br;
    let value = content;
    if (doubled) value = value.replace(DOUBLED_QUOTE, '"');
    // No breaks means no CR, so the content stands as it is; otherwise
    // each CRLF or lone CR in it reads as LF.
    if (br > 0) value = value.replace(CR_TO_LF, '\n');
    pos = close + 1;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; return { value, ended: COMMA }; }
    if (c === 10) { pos += 1; line += 1; return { value, ended: LINE_BREAK }; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false; // whether the last field read opened with a quote
    let ended = COMMA;

    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        // A quoted field.
        quoted = true;
        const f = readQuoted();
        fields.push(f.value);
        ended = f.ended;
        if (ended !== COMMA) break;
        continue;
      }

      // An unquoted field starts here: take the whole run of unquoted
      // fields up to the next quoted field or the end of the record.
      // First, where this physical line ends.
      const lf = text.indexOf('\n', pos);
      let lineEnd;
      let breakLen;
      if (lf === -1) { lineEnd = n; breakLen = 0; }
      else if (lf > pos && text.charCodeAt(lf - 1) === 13) { lineEnd = lf - 1; breakLen = 2; }
      else { lineEnd = lf; breakLen = 1; }
      const lineText = text.slice(pos, lineEnd);

      if (lineText.indexOf('\r') !== -1) {
        // A lone CR sits in this line before its end: the slow path for
        // this field (it drops the CR and reports stray_cr); the rest of
        // the record is retried as a fresh run afterwards.
        quoted = false;
        const f = readUnquoted('');
        fields.push(f.value);
        ended = f.ended;
        if (ended !== COMMA) break;
        continue;
      }

      // The next quoted field in this line, if any: the first quote that
      // opens a field, i.e. the first character of a field. A quote
      // anywhere else is a literal inside an unquoted field, and the run
      // goes straight past it.
      let runEnd = lineEnd;
      let q = lineText.indexOf('"');
      while (q !== -1) {
        if (q === 0 || lineText.charCodeAt(q - 1) === 44) { runEnd = pos + q - 1; break; }
        q = lineText.indexOf('"', q + 1);
      }
      const run = runEnd === lineEnd ? lineText : lineText.slice(0, runEnd - pos);
      const parts = run.split(',');
      for (let i = 0; i < parts.length; i++) fields.push(parts[i]);
      quoted = false;
      if (runEnd === lineEnd) {
        // The run took the record to its end.
        pos = lineEnd + breakLen;
        if (breakLen) line += 1;
        ended = breakLen ? LINE_BREAK : END;
        break;
      }
      // Step over the comma onto the opening quote of the next field.
      pos = runEnd + 1;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
