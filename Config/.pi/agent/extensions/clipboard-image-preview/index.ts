import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
	CustomEditor,
	convertToPng,
	getAgentDir,
	resizeImage,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Image,
	getCapabilities,
	getImageDimensions,
	truncateToWidth,
	type EditorComponent,
	type TUI,
} from "@earendil-works/pi-tui";

const WIDGET = "personal.clipboard-image-preview";
const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};
const prefix = join(tmpdir(), "pi-clipboard-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathsPattern = new RegExp(`${prefix}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:png|jpg|gif|webp)(?:(?=${prefix})|(?![\\w.\\\\/-]))`, "g");

type Preview = {
	path: string;
	abort: AbortController;
	status: "queued" | "loading" | "ready" | "unavailable";
	data?: string;
	image?: Image;
	height?: number;
};

async function readBounded(path: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
	signal.throwIfAborted();
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error("Unavailable preview");
		const bytes = Buffer.alloc(stat.size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		signal.throwIfAborted();
		if (offset !== stat.size) throw new Error("Preview changed while reading");
		return bytes.subarray(0, offset);
	} finally {
		await file.close();
	}
}

class DraftPreviews {
	private disposed = false;
	private text: string | undefined;
	private suppressed: string | undefined;
	private references = "";
	private entries = new Map<string, Preview>();
	private running = 0;
	private scheduled = false;
	private showImages = false;
	private settingsAbort = new AbortController();
	private settingsPending = false;
	private restore: (() => void) | undefined;

	constructor(private ctx: ExtensionContext, private tui: TUI) {}

	private release(entry: Preview): void {
		entry.abort.abort();
		entry.data = undefined;
		entry.image = undefined;
	}

	private clear(): void {
		for (const entry of this.entries.values()) this.release(entry);
		this.entries.clear();
		this.tui.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.settingsAbort.abort();
		this.restore?.();
		this.restore = undefined;
		this.clear();
	}

	observe(text: string): void {
		if (this.disposed || this.text === text) return;
		this.text = text;
		if (this.suppressed === text) return;
		this.suppressed = undefined;
		const referenced = [...new Set(text.match(pathsPattern) ?? [])];
		const references = referenced.join("\0");
		if (this.references !== references) {
			this.references = references;
			if (referenced.length) queueMicrotask(() => { void this.refreshSettings(); });
		}
		const paths = this.showImages && getCapabilities().images ? referenced : [];
		const next = new Map<string, Preview>();
		for (const path of paths) {
			next.set(path, this.entries.get(path) ?? { path, abort: new AbortController(), status: "queued" });
		}
		for (const [path, entry] of this.entries) {
			if (!next.has(path)) this.release(entry);
		}
		this.entries = next;
		this.schedule();
		this.tui.requestRender();
	}

	attach(editor: EditorComponent): void {
		const cleanups: (() => void)[] = [];
		for (const key of ["onChange", "onSubmit"] as const) {
			const descriptor = Object.getOwnPropertyDescriptor(editor, key);
			let callback = editor[key];
			const state = this;
			const wrapped = function (this: EditorComponent, ...args: [string]) {
				if (key === "onSubmit" && !state.disposed) {
					state.suppressed = editor.getExpandedText?.() ?? editor.getText();
					state.text = state.suppressed;
					state.clear();
				}
				try {
					return callback?.apply(this, args);
				} finally {
					if (key === "onChange") state.observe(editor.getExpandedText?.() ?? editor.getText());
				}
			};
			Object.defineProperty(editor, key, {
				configurable: true,
				enumerable: descriptor?.enumerable ?? true,
				get: () => wrapped,
				set: (value) => { callback = value; },
			});
			cleanups.push(() => {
				Object.defineProperty(editor, key, {
					configurable: true,
					enumerable: descriptor?.enumerable ?? true,
					writable: true,
					value: callback,
				});
			});
		}
		this.restore = () => { for (const cleanup of cleanups) cleanup(); };
	}

	async refreshSettings(): Promise<void> {
		if (this.disposed || this.settingsPending) return;
		this.settingsPending = true;
		try {
			const values = await Promise.all([
				join(getAgentDir(), "settings.json"),
				join(this.ctx.cwd, ".pi", "settings.json"),
			].map(async (path) => {
				try {
					const bytes = await readBounded(path, 1024 * 1024, this.settingsAbort.signal);
					const value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")).terminal?.showImages;
					return typeof value === "boolean" ? value : undefined;
				} catch {
					return undefined;
				}
			}));
			if (this.disposed) return;
			this.showImages = values[1] ?? values[0] ?? true;
			this.text = undefined;
			this.observe(this.ctx.ui.getEditorText());
		} finally {
			this.settingsPending = false;
		}
	}

	private schedule(): void {
		if (this.scheduled || this.disposed) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (this.disposed) return;
			for (const entry of this.entries.values()) {
				if (this.running >= 2) break;
				if (entry.status !== "queued") continue;
				entry.status = "loading";
				this.running++;
				void this.load(entry).finally(() => {
					this.running--;
					this.schedule();
				});
			}
		});
	}

	private current(entry: Preview): boolean {
		return !this.disposed && !entry.abort.signal.aborted && this.entries.get(entry.path) === entry;
	}

	private async load(entry: Preview): Promise<void> {
		try {
			const bytes = await readBounded(entry.path, 32 * 1024 * 1024, entry.abort.signal);
			if (!this.current(entry)) return;
			const mimeType = MIME[extname(entry.path)];
			if (!mimeType) throw new Error("Unavailable preview");
			const dimensions = getImageDimensions(bytes.toString("base64"), mimeType);
			if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1 ||
				dimensions.widthPx * dimensions.heightPx > 40_000_000) throw new Error("Unavailable preview");
			const thumbnail = await resizeImage(bytes, mimeType, { maxWidth: 384, maxHeight: 256, maxBytes: 512 * 1024 });
			if (!this.current(entry)) return;
			if (!thumbnail) throw new Error("Unavailable preview");
			const png = await convertToPng(thumbnail.data, thumbnail.mimeType);
			if (!this.current(entry)) return;
			if (!png) throw new Error("Unavailable preview");
			entry.data = png.data;
			entry.status = "ready";
		} catch {
			if (this.current(entry)) entry.status = "unavailable";
		} finally {
			if (this.current(entry)) this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.disposed) return [];
		this.observe(this.ctx.ui.getEditorText());
		if (!this.showImages || !getCapabilities().images || !this.entries.size || width < 1) return [];
		const theme = this.ctx.ui.theme;
		const height = Math.max(1, Math.min(3, Math.floor((this.tui.terminal.rows / 3 - 1) / this.entries.size)));
		const stack = new Container();
		let index = 0;
		for (const entry of this.entries.values()) {
			index++;
			if (entry.data && width >= 3) {
				if (!entry.image || entry.height !== height) {
					entry.image = new Image(entry.data, "image/png", { fallbackColor: (text) => this.ctx.ui.theme.fg("dim", text) }, {
						maxWidthCells: 24,
						maxHeightCells: height,
						imageId: entry.image?.getImageId(),
					});
					entry.height = height;
				}
				stack.addChild(entry.image);
			} else {
				const label = `Image ${index}: ${entry.status === "unavailable" ? "preview unavailable" : entry.data ? "preview" : "loading…"}`;
				stack.addChild({ render: (w) => [truncateToWidth(theme.fg("dim", label), w)], invalidate() {} });
			}
		}
		return [truncateToWidth(theme.fg("dim", `Clipboard previews · draft only · ${this.entries.size}`), width), ...stack.render(width)];
	}

	invalidate(): void {
		for (const entry of this.entries.values()) entry.image?.invalidate();
		queueMicrotask(() => { void this.refreshSettings(); });
	}
}

export default function (pi: ExtensionAPI): void {
	let pending = false;
	let active: DraftPreviews | undefined;
	let installation: { live: boolean } | undefined;
	let context: ExtensionContext | undefined;

	function stop(): void {
		if (installation) installation.live = false;
		active?.dispose();
		active = undefined;
		if (context?.mode === "tui") context.ui.setWidget(WIDGET, undefined);
		context = undefined;
		pending = false;
	}

	pi.on("session_start", (_event, ctx) => {
		stop();
		pending = ctx.mode === "tui";
	});

	pi.on("resources_discover", (_event, ctx) => {
		if (!pending || ctx.mode !== "tui") return;
		pending = false;
		context = ctx;
		const lifetime = { live: true };
		installation = lifetime;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous
				? previous(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			if (!lifetime.live) return editor;
			active?.dispose();
			const previews = new DraftPreviews(ctx, tui);
			active = previews;
			previews.attach(editor);
			ctx.ui.setWidget(WIDGET, () => previews, { placement: "aboveEditor" });
			void previews.refreshSettings();
			return editor;
		});
	});

	pi.on("session_shutdown", stop);
}
