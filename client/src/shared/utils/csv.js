/**
 * CSV that opens cleanly in Excel: a UTF-8 byte-order mark (so names with special characters
 * are not garbled), CRLF line ends, and quoting for commas, quotes and line breaks.
 *
 *   columns  [[header, row => value], ...]
 */

const escapeCell = (value) => {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function toCsv(columns, rows) {
  const lines = [columns.map(([header]) => escapeCell(header)).join(",")];
  rows.forEach((row) => lines.push(columns.map(([, read]) => escapeCell(read(row))).join(",")));
  return lines.join("\r\n");
}

/** Saves `text` as a .csv file in the viewer's downloads. */
export function downloadCsv(filename, text) {
  const blob = new Blob(["﻿", text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
