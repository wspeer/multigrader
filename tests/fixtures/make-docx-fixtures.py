"""Make the small Word test files used by tests/e2e-docx.js.

  python3 tests/fixtures/make-docx-fixtures.py

word-typed-sample.docx: typed numbers (1. 2. ...), a question that is only a
picture with its number inside, headings, page breaks, an essay part with a
"(continued)" question, and a second multiple-choice part. "Version A" is in
the header and the title.
word-auto-sample.docx: Word's automatic numbering, with lettered answer-choice
lists.
"""
import os, struct, zlib, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def run(t, bold=False):
    parts = t.split("\t")
    out = []
    for i, p in enumerate(parts):
        if i:
            out.append("<w:tab/>")
        if p:
            out.append(f'<w:t xml:space="preserve">{esc(p)}</w:t>')
    rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return f"<w:r>{rpr}{''.join(out)}</w:r>"


def para(t="", bold=False, center=False, num=None, extra=""):
    ppr = ""
    bits = []
    if num:
        bits.append(f'<w:numPr><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>')
    if center:
        bits.append('<w:jc w:val="center"/>')
    if bits:
        ppr = "<w:pPr>" + "".join(bits) + "</w:pPr>"
    return f"<w:p>{ppr}{run(t, bold) if t else ''}{extra}</w:p>"


def math_para(prefix, latexish):
    return f'<w:p>{run(prefix)}<m:oMath><m:r><m:t>{esc(latexish)}</m:t></m:r></m:oMath></w:p>'


PAGE = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'


def picture(rid, trail_break=False):
    d = ('<w:r><w:drawing><wp:inline><wp:extent cx="1828800" cy="914400"/><wp:docPr id="1" name="Picture 1"/>'
         '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
         '<pic:nvPicPr><pic:cNvPr id="1" name="q4.png"/><pic:cNvPicPr/></pic:nvPicPr>'
         f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
         '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
         '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>')
    br = '<w:r><w:br w:type="page"/></w:r>' if trail_break else ""
    return f"<w:p>{d}{br}</w:p>"


def png(w=60, h=30):
    raw = b"".join(b"\x00" + bytes([255, 255, 255] * w) for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def mc(n, q, choices, blanks=2):
    out = [para(f"{n}.\t{q}")]
    out += [para(f"\t{'abcdef'[i]})  {c}") for i, c in enumerate(choices)]
    out += [para() for _ in range(blanks)]
    return out


def write(name, body, numbering=None, header=None, media=None):
    sect = '<w:sectPr>' + ('<w:headerReference w:type="default" r:id="rIdH"/>' if header else "") + '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
    doc = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {W}><w:body>{"".join(body)}{sect}</w:body></w:document>'
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          + ('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' if numbering else "")
          + ('<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' if header else "")
          + "</Types>")
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    drels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    if numbering:
        drels.append('<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>')
    if header:
        drels.append('<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>')
    if media:
        drels.append('<Relationship Id="rIdP" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>')
    drels.append("</Relationships>")
    with zipfile.ZipFile(os.path.join(HERE, name), "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in [("[Content_Types].xml", ct), ("_rels/.rels", rels), ("word/document.xml", doc), ("word/_rels/document.xml.rels", "".join(drels))]:
            zi = zipfile.ZipInfo(n, (2024, 1, 1, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
        if numbering:
            zi = zipfile.ZipInfo("word/numbering.xml", (2024, 1, 1, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, numbering)
        if header:
            zi = zipfile.ZipInfo("word/header1.xml", (2024, 1, 1, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr {W}>{para(header)}</w:hdr>')
        if media:
            zi = zipfile.ZipInfo("word/media/image1.png", (2024, 1, 1, 0, 0, 0))
            z.writestr(zi, media)


# --- typed numbers ---
body = [para("Unit 5 Test (Version A)", bold=True, center=True), para("Name: ____________"),
        para("PART ONE: MULTIPLE CHOICE", bold=True), para("Circle your answers."), para()]
body += mc(1, "Which number is prime?", ["4", "6", "7", "9"])
body += mc(2, "What is 3 + 4?", ["5", "6", "7", "8"])
body += [math_para("3.\tSolve ", "2x+1=7"), para("\ta)  1\t b)  2\t c)  3\t d)  4"), para()]
body += [PAGE, picture("rIdP", trail_break=True)]  # 4: picture with its number inside
body += mc(5, "Which shape has three sides?", ["square", "triangle", "circle", "hexagon"])
body += mc(6, "What is half of 10?", ["2", "5", "10", "20"], blanks=1)
body += [PAGE, para("PART TWO: SHOW ALL WORK", bold=True, center=True), para()]
body += [para("7.\tSimplify each expression."), para("a)  2(x + 3)"), para("b)  x + x"), para(), PAGE,
         para("7.  (continued)"), para("c)  3x - x"), para()]
body += [para("8.\tExplain why the sum of two even numbers is even."), para(), para(), PAGE]
body += [para("Part Three: Multiple choice", bold=True), para("Circle the best answer."), para()]
body += mc(9, "What is 9 - 3?", ["3", "6", "9", "12"])
body += mc(10, "Which is largest?", ["0.5", "0.05", "0.55", "0.505"])
body += mc(11, "How many sides does a pentagon have?", ["4", "5", "6", "8"])
body += [para("End of test")]
write("word-typed-sample.docx", body, header="Unit 5 Test, Version A", media=png())

# --- automatic numbering ---
numbering = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
             '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>'
             '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>'
             '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
             + "".join(f'<w:num w:numId="{10 + i}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>' for i in range(5))
             + "</w:numbering>")
qs = [("Alpha question", ["one", "two", "three", "four"]), ("Bravo question", ["five", "six", "seven", "eight"]),
      ("Charlie question", ["red", "green", "blue", "gold"]), ("Delta question", ["north", "south", "east", "west"]),
      ("Echo question", ["up", "down", "left", "right"])]
body = [para("Quiz, Version A", bold=True, center=True), para()]
for i, (q, ch) in enumerate(qs):
    body.append(para(q, num=(1, 0)))
    body += [para(c, num=(10 + i, 0)) for c in ch]
    body.append(para())
write("word-auto-sample.docx", body, numbering=numbering)
print("ok")
