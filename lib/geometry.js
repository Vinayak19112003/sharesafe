export function validBox(box, width, height) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isInteger)
    && box[0] >= 0 && box[1] >= 0 && box[2] <= width && box[3] <= height
    && box[2] > box[0] && box[3] > box[1];
}

export function padBox([left, top, right, bottom], width, height, padding = 8) {
  return [Math.max(0, left - padding), Math.max(0, top - padding),
    Math.min(width, right + padding), Math.min(height, bottom + padding)];
}
