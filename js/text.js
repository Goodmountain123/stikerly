// text.js — builds a text item that behaves like a sticker on the canvas.

const TEXT_BASE_SIZE = 120;

export function buildTextGroup(item, opts = {}) {
  const group = new Konva.Group({
    x: item.x,
    y: item.y,
    draggable: !!opts.interactive,
    name: "item-group text-item-group",
  });
  group.setAttr("itemId", item.id);

  const art = new Konva.Text({
    text: item.text || "텍스트",
    fontFamily: item.fontFamily,
    fontSize: TEXT_BASE_SIZE,
    fontStyle: "normal",
    fill: item.color,
    align: "center",
    name: "item-art text-item-art",
  });
  art.setAttr("itemId", item.id);
  group.add(art);

  const size = { w: 1, h: 1 };

  function refresh() {
    art.text(item.text || "텍스트");
    art.fontFamily(item.fontFamily);
    art.fill(item.color);
    size.w = Math.max(1, art.width());
    size.h = Math.max(1, art.height());
    art.offset({ x: size.w / 2, y: size.h / 2 });
    art.rotation(item.rotation);
    art.scale({ x: item.scale, y: item.scale });
  }

  function transformOnly() {
    art.rotation(item.rotation);
    art.scale({ x: item.scale, y: item.scale });
  }

  refresh();
  return { group, art, size, refresh, transformOnly, item, isText: true };
}
