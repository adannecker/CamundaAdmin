"""Bounded, read-only XLSX text extraction. No formulas, macros or links execute."""
import io
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def read_xlsx(data):
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("Die Excel-Datei darf höchstens 4 MiB groß sein.")
    with zipfile.ZipFile(io.BytesIO(data)) as book:
        files = book.infolist()
        if len(files) > 1000 or sum(f.file_size for f in files) > 30 * 1024 * 1024:
            raise ValueError("Excel-Datei überschreitet die Größenlimits.")
        if any(f.flag_bits & 1 or f.filename.startswith('/') or '..' in f.filename.split('/') for f in files):
            raise ValueError("Ungültiges oder verschlüsseltes Excel-Archiv.")

        def xml(name):
            raw = book.read(name)
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
                raise ValueError("XML-Entitäten werden nicht unterstützt.")
            return ET.fromstring(raw)

        strings = []
        if 'xl/sharedStrings.xml' in book.namelist():
            strings = [''.join(s.itertext()) for s in xml('xl/sharedStrings.xml').findall('m:si', NS)]
            if len(strings) > 100000:
                raise ValueError("Zu viele Textwerte in Excel.")
        rels = {r.attrib['Id']: r.attrib['Target'] for r in xml('xl/_rels/workbook.xml.rels') if r.attrib.get('TargetMode') != 'External'}
        sheets, cells, rows_total = [], 0, 0
        for sheet in xml('xl/workbook.xml').findall('m:sheets/m:sheet', NS):
            target = rels.get(sheet.attrib[REL], '')
            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
            if not target.startswith('xl/worksheets/') or '..' in target.split('/'):
                raise ValueError("Ungültiger Tabellenblattpfad.")
            rows = []
            for row in xml(target).findall('m:sheetData/m:row', NS):
                values = []
                for cell in row.findall('m:c', NS):
                    address = re.fullmatch(r'([A-Z]+)([1-9][0-9]*)', cell.attrib.get('r', ''))
                    if not address:
                        raise ValueError("Ungültige Zelladresse.")
                    col = 0
                    for letter in address[1]:
                        col = col * 26 + ord(letter) - 64
                    if col > 50:
                        raise ValueError("Höchstens 50 Spalten werden unterstützt.")
                    value = cell.find('m:v', NS)
                    text = value.text or '' if value is not None else ''
                    if cell.attrib.get('t') == 's':
                        text = strings[int(text)]
                    elif cell.attrib.get('t') == 'inlineStr':
                        inline = cell.find('m:is', NS)
                        text = ''.join(inline.itertext()) if inline is not None else ''
                    if len(text) > 1000:
                        raise ValueError("Eine Zelle enthält zu viel Text.")
                    while len(values) < col:
                        values.append('')
                    values[col - 1] = text.strip()
                    cells += 1
                if any(values):
                    rows.append({"row": int(row.attrib.get('r', '0')), "cells": values})
                    rows_total += 1
                if rows_total > 2000 or cells > 100000:
                    raise ValueError("Höchstens 2.000 befüllte Zeilen werden unterstützt.")
            if rows:
                sheets.append({"name": sheet.attrib.get('name', ''), "rows": rows})
            if len(sheets) > 10:
                raise ValueError("Höchstens zehn Tabellenblätter werden unterstützt.")
        if not sheets:
            raise ValueError("Die Excel-Datei enthält keine lesbaren Daten.")
        return {"sheets": sheets}


if __name__ == '__main__':
    try:
        result = read_xlsx(sys.stdin.buffer.read(4 * 1024 * 1024 + 1))
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
    except ValueError as error:
        sys.stdout.buffer.write(json.dumps({"error": str(error)}, ensure_ascii=False).encode('utf-8'))
        sys.exit(1)
    except Exception:
        sys.stdout.write(json.dumps({"error": "Excel-Datei ist ungültig oder wird nicht unterstützt. Bitte als .xlsx speichern."}))
        sys.exit(1)
