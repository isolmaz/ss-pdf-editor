import {
  Archive,
  ArrowClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  CheckSquare,
  Drop,
  Export,
  EyeSlash,
  FileDoc,
  FileText,
  Hash,
  Image,
  Lock,
  LockOpen,
  MagnifyingGlass,
  PenNib,
  Plus,
  PlusSquare,
  Scissors,
  Trash,
} from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { useState } from 'react';
import { OperationForm } from '../dialogs/OperationForm';
import type { OperationDialogSpec, OpRunResult } from '../dialogs/types';
import type { OperationRunContext } from '../dialogs/useOperationRun';

export interface ToolsRailPanelProps {
  readonly t: Translator;
  readonly activeSpec?: OperationDialogSpec | null;
  readonly context?: OperationRunContext | null;
  readonly onSelectTool?: (id: string) => void;
  readonly onBackToTools?: () => void;
  readonly onResult?: (result: OpRunResult) => void;
  readonly onOpenDialog?: (id: string) => void;
  readonly onPageAction?: (action: { kind: string; direction?: string }) => void;
  readonly onArmTool?: (tool: string) => void;
  readonly onOpenPalette?: () => void;
  /**
   * The groups the simple mode keeps (`commands.ts`'s split). Omitted means "show every
   * group", which is what the advanced mode and every existing caller get.
   *
   * Only the groups whose tools are *advanced* are hidden: redaction, encryption and the
   * stamp/watermark set. Page organising, export and signing stay, because a free reader
   * carries all three and hiding them would make the simple mode less capable than the
   * software it is measured against.
   */
  readonly visibleGroups?: readonly string[];
  readonly onExportModal?: () => void;
}

interface ToolItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon: React.ElementType;
  readonly onClick: () => void;
  readonly badge?: string;
}

interface ToolGroup {
  readonly id: string;
  readonly title: string;
  readonly items: readonly ToolItem[];
}

/**
 * An operation's settings, run and result, in the tools panel. The body is
 * `OperationForm` — the one implementation every operation uses — so what a capability
 * asks, the steps it shows and what each button does are the same everywhere.
 */
function InlineToolRunner({
  t,
  spec,
  context,
  onBack,
  onResult,
}: {
  readonly t: Translator;
  readonly spec: OperationDialogSpec;
  readonly context: OperationRunContext;
  readonly onBack: () => void;
  readonly onResult?: (result: OpRunResult) => void;
}) {
  return (
    <section aria-label={t(spec.titleKey)} className="flex h-full flex-col bg-kumo-base p-3 select-none">
      <div className="mb-2 flex shrink-0 items-center border-b border-kumo-line/60 pb-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs font-semibold text-pdf-accent hover:underline"
        >
          <CaretLeft size={14} weight="bold" aria-hidden="true" />
          {t('tools.backToAll')}
        </button>
      </div>
      <OperationForm
        key={spec.id}
        t={t}
        spec={spec}
        context={context}
        onClose={onBack}
        // The host applies the result and closes the form itself once the result has
        // landed. Going "back" here as well aborted the apply that had just started — the
        // back path cancels the operation in flight — so a result applied from this panel
        // never reached the document.
        onResult={(result) => onResult?.(result)}
        renderTitle={(title) => <h2 className="text-sm font-semibold text-kumo-strong">{title}</h2>}
        renderIntro={(intro) => <p className="text-xs text-kumo-subtle">{intro}</p>}
      />
    </section>
  );
}

export function ToolsRailPanel({
  t,
  activeSpec,
  context,
  onSelectTool,
  onBackToTools,
  onResult,
  onOpenDialog,
  onPageAction,
  onArmTool,
  onOpenPalette,
  onExportModal,
  visibleGroups,
}: ToolsRailPanelProps) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    pages: true,
    export: true,
    sign: true,
    security: false,
    stamp: false,
  });

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const selectTool = (id: string) => {
    if (onSelectTool) {
      onSelectTool(id);
    } else {
      onOpenDialog?.(id);
    }
  };

  if (activeSpec && context) {
    return (
      <InlineToolRunner
        t={t}
        spec={activeSpec}
        context={context}
        onBack={() => onBackToTools?.()}
        onResult={onResult}
      />
    );
  }

  const allGroups: readonly ToolGroup[] = [
    {
      id: 'pages',
      title: t('tools.group.pages'),
      items: [
        {
          id: 'rotate',
          title: t('tools.rotate'),
          description: t('tools.rotateDesc'),
          icon: ArrowClockwise,
          onClick: () => onPageAction?.({ kind: 'rotate', direction: 'right' }),
        },
        {
          id: 'delete',
          title: t('tools.delete'),
          description: t('tools.deleteDesc'),
          icon: Trash,
          onClick: () => onPageAction?.({ kind: 'delete' }),
        },
        {
          id: 'extract-pages',
          title: t('tools.extract'),
          description: t('tools.extractDesc'),
          icon: Export,
          onClick: () => selectTool('extract-pages'),
        },
        {
          id: 'split',
          title: t('tools.split'),
          description: t('tools.splitDesc'),
          icon: Scissors,
          onClick: () => selectTool('split'),
        },
        {
          id: 'add-document',
          title: t('tools.combine'),
          description: t('tools.combineDesc'),
          icon: Plus,
          onClick: () => selectTool('add-document'),
        },
      ],
    },
    {
      id: 'export',
      title: t('tools.group.export'),
      items: [
        {
          id: 'export-modal',
          title: t('tools.exportOptions'),
          description: t('tools.exportOptionsDesc'),
          icon: FileText,
          badge: t('tools.badgeNew'),
          onClick: () => onExportModal?.(),
        },
        {
          id: 'compress',
          title: t('tools.compress'),
          description: t('tools.compressDesc'),
          icon: Archive,
          onClick: () => selectTool('compress'),
        },
        {
          id: 'export-images',
          title: t('tools.exportImages'),
          description: t('tools.exportImagesDesc'),
          icon: Image,
          onClick: () => selectTool('export-images'),
        },
        {
          id: 'export-text',
          title: t('tools.exportText'),
          description: t('tools.exportTextDesc'),
          icon: FileText,
          onClick: () => selectTool('export-text'),
        },
        {
          id: 'export-office',
          title: t('tools.exportOffice'),
          description: t('tools.exportOfficeDesc'),
          icon: FileDoc,
          onClick: () => selectTool('export-office'),
        },
      ],
    },
    {
      id: 'sign',
      title: t('tools.group.sign'),
      items: [
        {
          id: 'sign-doc',
          title: t('tools.sign'),
          description: t('tools.signDesc'),
          icon: PenNib,
          onClick: () => selectTool('sign'),
        },
        {
          id: 'form-fields',
          title: t('tools.formFill'),
          description: t('tools.formFillDesc'),
          icon: CheckSquare,
          onClick: () => selectTool('form-fields'),
        },
        {
          id: 'form-create-field',
          title: t('tools.formCreate'),
          description: t('tools.formCreateDesc'),
          icon: PlusSquare,
          onClick: () => selectTool('form-create-field'),
        },
      ],
    },
    {
      id: 'security',
      title: t('tools.group.security'),
      items: [
        {
          id: 'protect',
          title: t('tools.protect'),
          description: t('tools.protectDesc'),
          icon: Lock,
          onClick: () => selectTool('protect'),
        },
        {
          id: 'unlock',
          title: t('tools.unlock'),
          description: t('tools.unlockDesc'),
          icon: LockOpen,
          onClick: () => selectTool('unlock'),
        },
        {
          id: 'redact',
          title: t('tools.redact'),
          description: t('tools.redactDesc'),
          icon: EyeSlash,
          onClick: () => {
            onArmTool?.('redact');
            selectTool('redact');
          },
        },
      ],
    },
    {
      id: 'stamp',
      title: t('tools.group.stamp'),
      items: [
        {
          id: 'page-numbers',
          title: t('tools.pageNumbers'),
          description: t('tools.pageNumbersDesc'),
          icon: Hash,
          onClick: () => selectTool('page-numbers'),
        },
        {
          id: 'watermark',
          title: t('tools.watermark'),
          description: t('tools.watermarkDesc'),
          icon: Drop,
          onClick: () => selectTool('watermark'),
        },
      ],
    },
  ];

  // A group the mode does not offer is dropped whole; an empty group would render a
  // heading with nothing under it, which reads as a loading failure rather than a choice.
  const groups =
    visibleGroups === undefined ? allGroups : allGroups.filter((group) => visibleGroups.includes(group.id));

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-kumo-base p-2 select-none">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between border-b border-kumo-line/60 pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-kumo-subtle">
          {t('tools.all')}
        </h3>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-2">
        {groups.map((group) => {
          const isExpanded = expandedGroups[group.id] ?? false;
          return (
            <div
              key={group.id}
              className="overflow-hidden rounded-md border border-kumo-line/70 bg-kumo-base"
            >
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                className="flex w-full items-center justify-between px-2.5 py-2 text-left hover:bg-kumo-recessed/40 transition-colors"
              >
                <span className="text-xs font-semibold text-kumo-strong">{group.title}</span>
                {isExpanded ? (
                  <CaretDown size={13} className="text-kumo-subtle" />
                ) : (
                  <CaretRight size={13} className="text-kumo-subtle" />
                )}
              </button>

              {isExpanded ? (
                <div className="flex flex-col border-t border-kumo-line/40 bg-kumo-canvas/30 p-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={item.onClick}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-kumo-recessed text-kumo-default hover:text-kumo-strong transition-colors group"
                      >
                        <Icon size={15} className="shrink-0 text-kumo-subtle group-hover:text-pdf-accent" />
                        <span className="flex-1 truncate text-xs font-medium">{item.title}</span>
                        {item.badge ? (
                          <span className="rounded bg-pdf-accent/15 px-1 py-0.2 text-[11px] font-bold text-pdf-accent">
                            {item.badge}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Bottom quick command palette launcher */}
      <div className="mt-auto pt-3 border-t border-kumo-line/60">
        <button
          type="button"
          onClick={onOpenPalette}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-kumo-line bg-kumo-recessed px-2 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint hover:text-kumo-strong transition-colors"
        >
          <MagnifyingGlass size={14} />
          {t('tools.searchCommands')}
        </button>
      </div>
    </div>
  );
}
