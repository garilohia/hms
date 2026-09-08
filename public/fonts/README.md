# Embedded PDF fonts

Unmodified static Noto Sans and Noto Sans Devanagari Regular, SIL OFL 1.1.
Source: https://github.com/notofonts/noto-fonts/tree/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf

These files are bundled locally. Rendering never sends patient text to a font service.
The PDF renderer checks character coverage and declines unsupported scripts/emoji
instead of silently substituting or losing patient text. The HTML summary retains originals.
