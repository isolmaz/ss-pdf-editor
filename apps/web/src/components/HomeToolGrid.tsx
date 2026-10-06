/**
 * The home screen's "All tools" tab: every capability of the command registry that a
 * user would start a task with, grouped the way the task reads ("pages", "security"…).
 *
 * The grid adds no capability of its own. Each tile is a command id from `commands.ts`, its
 * title is that command's own label and pressing it runs that command — so the grid, the
 * menu bar and the `Ctrl+K` palette cannot disagree about what a tool is called or does.
 * What the grid adds is the order a newcomer looks for things in, a one-line description
 * and an icon. With no document open, a tool that needs one asks for the file first (the
 * shell's `onRun`); a standalone tool (images → PDF) runs straight away.
 *
 * Loaded on demand: the icons are only needed once the tab is opened, and the first paint
 * of the editor is budgeted.
 */

import {
  ArrowsIn,
  Camera,
  Certificate,
  Crop,
  Database,
  Drop,
  Eraser,
  FileArrowUp,
  FileDoc,
  FileImage,
  FilePlus,
  Files,
  FileText,
  GitDiff,
  Highlighter,
  type Icon,
  Image,
  ImageSquare,
  Images,
  Info,
  Link,
  ListBullets,
  ListNumbers,
  Lock,
  LockOpen,
  MagnifyingGlass,
  Note,
  PersonSimple,
  PlusSquare,
  Ruler,
  Scan,
  Scissors,
  Scribble,
  Shapes,
  ShieldCheck,
  Signature,
  SquaresFour,
  Swap,
  Tag,
  Textbox,
  TextT,
} from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import { useMemo, useState } from 'react';

type Category = 'edit' | 'pages' | 'convert' | 'sign' | 'security' | 'document';

interface ToolEntry {
  readonly id: string;
  readonly category: Category;
  readonly icon: Icon;
  readonly descriptionKey: MessageKey;
}

const CATEGORY_KEYS: Readonly<Record<Category, MessageKey>> = {
  edit: 'home.cat.edit',
  pages: 'home.cat.pages',
  convert: 'home.cat.convert',
  sign: 'home.cat.sign',
  security: 'home.cat.security',
  document: 'home.cat.document',
};

const CATEGORY_ORDER: readonly Category[] = ['edit', 'pages', 'convert', 'sign', 'security', 'document'];

/** Command ids in the order each category shows them. */
export const HOME_TOOLS: readonly ToolEntry[] = [
  { id: 'tools.text-edit', category: 'edit', icon: TextT, descriptionKey: 'home.tool.textEdit' },
  { id: 'edit.find-replace', category: 'edit', icon: Swap, descriptionKey: 'home.tool.findReplace' },
  { id: 'tools.highlight', category: 'edit', icon: Highlighter, descriptionKey: 'home.tool.highlight' },
  { id: 'tools.ink', category: 'edit', icon: Scribble, descriptionKey: 'home.tool.ink' },
  { id: 'tools.shapes', category: 'edit', icon: Shapes, descriptionKey: 'home.tool.shapes' },
  { id: 'tools.note', category: 'edit', icon: Note, descriptionKey: 'home.tool.note' },
  { id: 'tools.link', category: 'edit', icon: Link, descriptionKey: 'home.tool.link' },
  { id: 'tools.image-add', category: 'edit', icon: ImageSquare, descriptionKey: 'home.tool.imageAdd' },
  { id: 'tools.image-edit', category: 'edit', icon: Image, descriptionKey: 'home.tool.imageEdit' },
  { id: 'tools.measure-distance', category: 'edit', icon: Ruler, descriptionKey: 'home.tool.measure' },
  { id: 'page.insert', category: 'pages', icon: FilePlus, descriptionKey: 'home.tool.insert' },
  { id: 'file.add', category: 'pages', icon: Files, descriptionKey: 'home.tool.add' },
  { id: 'page.split', category: 'pages', icon: Scissors, descriptionKey: 'home.tool.split' },
  { id: 'page.boxes', category: 'pages', icon: Crop, descriptionKey: 'home.tool.boxes' },
  { id: 'page.labels', category: 'pages', icon: Tag, descriptionKey: 'home.tool.labels' },
  { id: 'tools.impose', category: 'pages', icon: SquaresFour, descriptionKey: 'home.tool.impose' },
  { id: 'tools.numbering', category: 'pages', icon: ListNumbers, descriptionKey: 'home.tool.numbering' },
  { id: 'file.convert', category: 'convert', icon: FileArrowUp, descriptionKey: 'home.tool.convert' },
  { id: 'file.create-images', category: 'convert', icon: Images, descriptionKey: 'home.tool.createImages' },
  { id: 'file.scan', category: 'convert', icon: Camera, descriptionKey: 'home.tool.scan' },
  {
    id: 'tools.export-images',
    category: 'convert',
    icon: FileImage,
    descriptionKey: 'home.tool.exportImages',
  },
  { id: 'tools.export-text', category: 'convert', icon: FileText, descriptionKey: 'home.tool.exportText' },
  { id: 'tools.export-office', category: 'convert', icon: FileDoc, descriptionKey: 'home.tool.exportOffice' },
  { id: 'tools.signature-simple', category: 'sign', icon: Signature, descriptionKey: 'home.tool.signature' },
  { id: 'tools.sign', category: 'sign', icon: Certificate, descriptionKey: 'home.tool.sign' },
  { id: 'tools.form-fields', category: 'sign', icon: Textbox, descriptionKey: 'home.tool.formFields' },
  { id: 'tools.form-create', category: 'sign', icon: PlusSquare, descriptionKey: 'home.tool.formCreate' },
  { id: 'tools.form-data', category: 'sign', icon: Database, descriptionKey: 'home.tool.formData' },
  { id: 'tools.redact', category: 'security', icon: Eraser, descriptionKey: 'home.tool.redact' },
  { id: 'tools.security', category: 'security', icon: Lock, descriptionKey: 'home.tool.protect' },
  { id: 'tools.unlock', category: 'security', icon: LockOpen, descriptionKey: 'home.tool.unlock' },
  { id: 'tools.redaction-audit', category: 'security', icon: ShieldCheck, descriptionKey: 'home.tool.audit' },
  { id: 'tools.optimize', category: 'document', icon: ArrowsIn, descriptionKey: 'home.tool.optimize' },
  { id: 'tools.ocr', category: 'document', icon: Scan, descriptionKey: 'home.tool.ocr' },
  { id: 'tools.watermark', category: 'document', icon: Drop, descriptionKey: 'home.tool.watermark' },
  { id: 'tools.properties', category: 'document', icon: Info, descriptionKey: 'home.tool.properties' },
  { id: 'tools.outline-edit', category: 'document', icon: ListBullets, descriptionKey: 'home.tool.outline' },
  {
    id: 'tools.accessibility',
    category: 'document',
    icon: PersonSimple,
    descriptionKey: 'home.tool.accessibility',
  },
  { id: 'tools.compare', category: 'document', icon: GitDiff, descriptionKey: 'home.tool.compare' },
];

/** Case- and accent-insensitive search text (`İ`/`ı`/`ş` fold the way a Turkish user types them). */
function fold(text: string): string {
  return text.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

export interface HomeToolGridProps {
  readonly t: Translator;
  /** Every command of the registry; the grid picks the ones it lays out. */
  readonly commands: readonly Command[];
  /** The tab tools apply to, or `null` when the tool asks for a file first. */
  readonly activeDocumentName: string | null;
  /** Commands that start a document and never need one open. */
  readonly standalone: ReadonlySet<string>;
  readonly onRun: (commandId: string) => void;
}

export default function HomeToolGrid({
  t,
  commands,
  activeDocumentName,
  standalone,
  onRun,
}: HomeToolGridProps) {
  const [query, setQuery] = useState('');
  const byId = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands]);
  const needle = fold(query.trim());

  const sections = CATEGORY_ORDER.map((category) => ({
    category,
    tools: HOME_TOOLS.filter((tool) => tool.category === category).flatMap((tool) => {
      const command = byId.get(tool.id);
      if (command === undefined) return [];
      const title = t(command.labelKey);
      const description = t(tool.descriptionKey);
      if (needle.length > 0) {
        const haystack = fold([title, description, ...(command.keywords ?? [])].join(' '));
        if (!haystack.includes(needle)) return [];
      }
      // With no document, a tool that needs one is offered anyway: pressing it asks for the
      // file. With one open, the command's own enablement (viewing-only, a running job) holds.
      const disabled = activeDocumentName !== null && command.disabled === true && !standalone.has(tool.id);
      return [{ ...tool, title, description, disabled }];
    }),
  })).filter((section) => section.tools.length > 0);

  return (
    <div className="mt-5 flex flex-col gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-kumo-subtle">
          {activeDocumentName === null
            ? t('home.tools.noDocument')
            : t('home.tools.activeDocument', { name: activeDocumentName })}
        </p>
        <label className="relative block w-full sm:w-64">
          <span className="sr-only">{t('home.tools.search')}</span>
          <MagnifyingGlass
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-kumo-subtle"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('home.tools.search')}
            className="w-full rounded-md border border-kumo-line bg-kumo-base py-1.5 pr-2 pl-8 text-xs text-kumo-default placeholder:text-kumo-subtle focus:border-kumo-focus focus:outline-none"
          />
        </label>
      </div>
      {sections.length === 0 ? (
        <p className="py-10 text-center text-xs text-kumo-subtle">{t('home.tools.empty')}</p>
      ) : (
        sections.map((section) => (
          <section key={section.category} aria-labelledby={`home-cat-${section.category}`}>
            <h3
              id={`home-cat-${section.category}`}
              className="mb-2 text-[11px] font-semibold tracking-wider text-kumo-subtle uppercase"
            >
              {t(CATEGORY_KEYS[section.category])}
            </h3>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {section.tools.map((tool) => {
                const ToolIcon = tool.icon;
                return (
                  <li key={tool.id}>
                    <button
                      type="button"
                      disabled={tool.disabled}
                      onClick={() => onRun(tool.id)}
                      className="group flex h-full w-full items-start gap-3 rounded-lg border border-kumo-line bg-kumo-base p-3 text-left transition-colors hover:border-kumo-contrast hover:bg-kumo-recessed focus-visible:border-kumo-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-kumo-recessed text-pdf-accent">
                        <ToolIcon size={18} weight="duotone" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-kumo-strong">{tool.title}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-kumo-subtle">
                          {tool.description}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
