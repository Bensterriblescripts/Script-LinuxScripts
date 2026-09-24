import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
const prefix = join(tmpdir(), "pi-clipboard-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathsPattern = new RegExp(`${prefix}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:png|jpg|gif|webp)(?:(?=${prefix})|(?![\\w.\\\\/-]))`, "g");
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;

export function clipboardPaths(text: string): string[] {
	return [...new Set(text.match(pathsPattern) ?? [])];
}

async function readImage(path: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
	signal.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("not a regular file");
		if (stat.size < 1 || stat.size > maximum) throw new Error("image exceeds the 32 MiB file / 64 MiB draft limit, or is empty");
		const bytes = Buffer.alloc(stat.size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		signal.throwIfAborted();
		const after = await file.stat();
		if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
			throw new Error("image changed while reading; paste it again");
		}
		return bytes.subarray(0, offset);
	} finally {
		await file.close();
	}
}

export async function prepareClipboardImages(text: string, supplied: ImageContent[] | undefined, signal: AbortSignal): Promise<ImageContent[]> {
	const images = [...(supplied ?? [])];
	const paths = clipboardPaths(text);
	if (paths.length > 16) throw new Error("At most 16 clipboard image references can be sent in one Build draft.");
	let total = 0;
	for (const path of paths) {
		try {
			const bytes = await readImage(path, Math.min(MAX_BYTES, MAX_TOTAL_BYTES - total), signal);
			total += bytes.length;
			const mimeType = MIME[extname(path)];
			const data = bytes.toString("base64");
			const dimensions = getImageDimensions(data, mimeType);
			if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1 || dimensions.widthPx * dimensions.heightPx > MAX_PIXELS) {
				throw new Error("invalid image or more than 40 million pixels");
			}
			const decoded = await resizeImage(bytes, mimeType, { maxWidth: MAX_PIXELS, maxHeight: MAX_PIXELS, maxBytes: MAX_BYTES * 2 });
			signal.throwIfAborted();
			if (!decoded) throw new Error("image could not be decoded; paste a fresh image");
			if (!images.some((image) => image.mimeType === mimeType && image.data === data)) {
				images.push({ type: "image", mimeType, data });
			}
		} catch (error) {
			signal.throwIfAborted();
			throw new Error(`Could not attach ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	signal.throwIfAborted();
	return images;
}
