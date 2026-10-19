# 文件用途：用独立 PDF 解析器和 Poppler 验收导出文件、字体、原图及横竖视角一致性。
import argparse
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw
from pypdf import PdfReader


def has_embedded_font(font):
    """同时识别普通字体与 CID 后代字体的嵌入字体流。"""
    font = font.get_object()
    descriptor = font.get('/FontDescriptor')
    if descriptor:
        descriptor = descriptor.get_object()
        if any(key in descriptor for key in ('/FontFile', '/FontFile2', '/FontFile3')):
            return True
    return any(has_embedded_font(child) for child in font.get('/DescendantFonts', []))


def verify(directory):
    """输入 smoke:pdf 生成的报告目录；任一断言失败以非零退出，保留 PNG 供目视复核。"""
    root = directory.resolve()
    report = json.loads((root / 'report.json').read_text(encoding='utf-8'))
    reader = PdfReader(report['finalPdf'])
    assert len(reader.pages) == report['pageCount'] == 10
    font_count = 0
    for number, (page, label) in enumerate(zip(reader.pages, report['expectedPageLabels']), 1):
        assert abs(float(page.mediabox.width) - 210 / 25.4 * 72) < 0.0001, number
        assert abs(float(page.mediabox.height) - 297 / 25.4 * 72) < 0.0001, number
        assert page.rotation == 0, number
        assert list(page.cropbox) == list(page.mediabox), number
        text = page.extract_text()
        if label is None:
            assert not text.strip() and not list(page.images), number
            continue
        assert f'第 {label} 页' in text and '中文画册 ABC 123' in text, (number, text)
        assert tuple(report['originalImagePixels']) in [item.image.size for item in page.images], number
        fonts = page['/Resources']['/Font'].get_object()
        assert fonts, number
        for font in fonts.values():
            assert has_embedded_font(font), (number, font)
            font_count += 1

    # 采用同一渲染器逐页比对，不能以 PDF 字节不同认定排版变化。
    for name, source in [('before', report['baseline']), ('after', report['rotated']), ('page', report['finalPdf'])]:
        subprocess.run(['pdftoppm', '-r', '72', '-png', source, str(root / name)], check=True)
    before = sorted(root.glob('before-*.png'))
    after = sorted(root.glob('after-*.png'))
    assert len(before) == len(after) == 10
    for left, right in zip(before, after):
        assert ImageChops.difference(Image.open(left).convert('RGB'), Image.open(right).convert('RGB')).getbbox() is None, left

    files = sorted(root.glob('page-*.png'))
    blank = Image.open(files[-1]).convert('RGB')
    assert ImageChops.difference(blank, Image.new('RGB', blank.size, 'white')).getbbox() is None
    board = Image.new('RGB', (1200, 840), '#dddddd')
    for index, path in enumerate(files):
        image = Image.open(path).convert('RGB')
        image.thumbnail((230, 380))
        x, y = (index % 5) * 240, (index // 5) * 420
        board.paste(image, (x + 5, y + 25))
        ImageDraw.Draw(board).text((x + 5, y + 5), str(index + 1), fill='black')
    board.save(root / 'contact.png')
    result = {'pages': 10, 'exactA4': True, 'rotationFlagsZero': True, 'pageOrder': True,
              'originalImagePixelsPreserved': True, 'embeddedFontReferences': font_count,
              'viewChangePixelIdenticalPages': 10, 'blankPagePreserved': True,
              'manualReview': 'contact.png 与 page-*.png；实体试印未执行'}
    (root / 'pdf-check.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='检查 smoke:pdf 的真实输出，需要 pypdf、Pillow 与 Poppler。')
    parser.add_argument('directory', type=Path)
    verify(parser.parse_args().directory)
