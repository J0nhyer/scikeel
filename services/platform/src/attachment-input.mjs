export const codexImageArgs = (paths) => paths.flatMap((path) => ["--image", path]);
export function claudeUserInput(text, images) {
  return JSON.stringify({ type: "user", message: { role: "user", content: [
    { type: "text", text }, ...images.map(({ mime, data }) => ({ type: "image", source: { type: "base64", media_type: mime, data } })),
  ] } }) + "\n";
}
