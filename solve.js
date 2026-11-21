// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers as the reference, bit for bit: {columns, rows, errors} for
// every {text, header}. The reference walks the text one character at a time
// and builds every field by concatenation; this one walks it once too, but
// jumps between delimiters with indexOf (C-level memchr) and cuts each field
// out with a single slice, so the common path does no per-character work at
// all. Only the rare broken bits (a stray CR, a doubled quote, a CR inside a
// quoted field) pay for a second look.
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

  // Count the line breaks in text[a..b): one per LF, one per CRLF, one per
  // lone CR.
  function countBreaks(a, b) {
    let c = 0;
    let i = a;
    for (;;) {
      const j = text.indexOf('\n', i);
      if (j === -1 || j >= b) break;
      c += 1;
      i = j + 1;
    }
    i = a;
    for (;;) {
      const j = text.indexOf('\r', i);
      if (j === -1 || j >= b) break;
      // A CR that is part of a CRLF was already counted with its LF.
      if (text.charCodeAt(j + 1) !== 10) c += 1;
      i = j + 1;
    }
    return c;
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept.
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

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null; // segments, only when a doubled quote or CR splits it
    let segStart = pos + 1;
    let scan = pos + 1;
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
        if (parts === null) parts = [];
        const seg = text.slice(segStart, q);
        line += countBreaks(segStart, q);
        parts.push(seg.indexOf('\r') === -1 ? seg : seg.replace(/\r\n|\r/g, '\n'));
        parts.push('"');
        scan = q + 2;
        segStart = q + 2;
        continue;
      }
      // The closing quote is at q; the last segment is [segStart, q).
      const seg = text.slice(segStart, q);
      line += countBreaks(segStart, q);
      let value;
      if (parts === null) {
        value = seg.indexOf('\r') === -1 ? seg : seg.replace(/\r\n|\r/g, '\n');
      } else {
        parts.push(seg.indexOf('\r') === -1 ? seg : seg.replace(/\r\n|\r/g, '\n'));
        value = parts.join('');
      }
      pos = q + 1;
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
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

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
