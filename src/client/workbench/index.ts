// workbench-ui: components, hooks and helpers. CSS: import "./styles/index.css" once.

// shell
export {
  AppShell,
  DEFAULT_MAIN_ID,
  SidebarToggle,
  SkipLink,
  useAppShell,
} from "./components/AppShell";
export type {
  AppShellProps,
  AppShellState,
  ShowSidebarOptions,
} from "./components/AppShell";
export {
  Brand,
  NavTab,
  NavTabs,
  ThemeMenu,
  TopBar,
  TopSearch,
  TopStatus,
} from "./components/TopBar";
export type { NavTabProps } from "./components/TopBar";
export {
  Sidebar,
  SidebarCheck,
  SidebarEmpty,
  SidebarItem,
  SidebarMore,
  SidebarQuick,
  SidebarSection,
  SidebarTop,
} from "./components/Sidebar";
export type {
  SidebarItemProps,
  SidebarSectionAction,
  SidebarSectionProps,
} from "./components/Sidebar";
export {
  Ctl,
  Main,
  Spacer,
  Toolbar,
  ToolbarRow,
  ToolbarSummary,
  ToolbarTitle,
} from "./components/Main";
export type { MainProps } from "./components/Main";

// lists
export {
  GroupHeader,
  List,
  ListFooter,
  ListGroup,
  ListNote,
  ListRow,
  Rows,
} from "./components/List";
export type { ListRowProps } from "./components/List";
export {
  findRow,
  findRowTarget,
  ROW_ID_ATTR,
  useListCursor,
} from "./lib/listCursor";
export type { ListCursor, ListCursorOptions } from "./lib/listCursor";

// tables
export {
  DataTable,
  nextSort,
  SortHeader,
  TableEmpty,
  TableGroupHeader,
  TableSkeletonRows,
} from "./components/Table";
export type {
  DataColumn,
  DataTableProps,
  SortDir,
  SortState,
} from "./components/Table";
export { ListPager } from "./components/Pager";
export type { ListPagerProps } from "./components/Pager";
export { Sparkline } from "./components/Sparkline";
export type { SparklineProps } from "./components/Sparkline";
export { QualifiedName, TruncateStart } from "./components/Text";

// drawer
export { Drawer, DrawerSection, KeyValue } from "./components/Drawer";
export type { DrawerProps, KeyValueItem } from "./components/Drawer";

// navigation and controls
export { LinkTabs, TabPanel, tabId, tabPanelId, Tabs } from "./components/Tabs";
export type { LinkTabItem, TabItem, TabsProps } from "./components/Tabs";
export { Seg, SegLinks } from "./components/Seg";
export type { SegLinkItem, SegOption, SegProps } from "./components/Seg";
export {
  Avatar,
  Badge,
  Chip,
  ChipToggle,
  Kbd,
  StateCell,
  StatePill,
  StatusDot,
} from "./components/Chips";
export type {
  BadgeProps,
  ChipProps,
  ChipToggleProps,
} from "./components/Chips";
export { Button, buttonClass, IconButton } from "./components/Button";
export type {
  ButtonAsButtonProps,
  ButtonAsLinkProps,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  IconButtonProps,
} from "./components/Button";
export {
  AppLink,
  LinkProvider,
  PlainLink,
  useLinkComponent,
} from "./components/Link";
export type { LinkComponent, LinkProps } from "./components/Link";
export { Spinner } from "./components/Spinner";

// forms
export {
  Checkbox,
  Field,
  FieldProvider,
  Input,
  Select,
  Switch,
  Textarea,
  useFieldContext,
  useFieldControl,
} from "./components/Form";
export type {
  CheckboxProps,
  FieldProps,
  InputProps,
  SelectOption,
  SelectProps,
  SwitchProps,
  TextareaProps,
} from "./components/Form";
export { FilterInput } from "./components/FilterInput";
export type { FilterInputProps } from "./components/FilterInput";
export { Combobox } from "./components/Combobox";
export type {
  ComboboxMultipleProps,
  ComboboxProps,
  ComboboxSingleProps,
  ComboOption,
} from "./components/Combobox";

// overlays
export { Menu, Popover } from "./components/Popover";
export type {
  PopoverInitialFocus,
  MenuEntry,
  MenuHeading,
  MenuItem,
  MenuProps,
  MenuSeparator,
  MenuTriggerProps,
  Placement,
  PopoverProps,
} from "./components/Popover";
export {
  ConfirmDialog,
  ConfirmProvider,
  Modal,
  useConfirm,
} from "./components/Modal";
export type {
  ConfirmDialogProps,
  ConfirmFn,
  ConfirmOptions,
  ModalProps,
} from "./components/Modal";
export { CommandPalette } from "./components/CommandPalette";
export type {
  CommandPaletteProps,
  PaletteItem,
  PaletteSource,
  PaletteStep,
} from "./components/CommandPalette";
export { ToastProvider, useToast } from "./components/Toast";
export type { ToastFn, ToastOptions } from "./components/Toast";

// states
export {
  Banner,
  DraftBar,
  EmptyState,
  ErrorState,
  errorMessage,
  Meter,
  ProgressBar,
  Skeleton,
  SkeletonBlock,
  SkeletonRows,
  SkeletonSidebar,
} from "./components/States";
export type {
  BannerProps,
  EmptyStateProps,
  ErrorStateProps,
  MeterProps,
} from "./components/States";

// pages
export {
  Card,
  Disclosure,
  PageHeader,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  Tile,
} from "./components/Pages";
export type { TileDelta } from "./components/Pages";
export { MediaFrame } from "./components/MediaFrame";
export type { MediaFrameProps } from "./components/MediaFrame";
export { MediaZoomControls } from "./components/MediaZoomControls";
export type { MediaZoomControlsProps } from "./components/MediaZoomControls";

// icons, time
export { Icon, iconNames } from "./components/Icon";
export type { IconName, IconProps } from "./components/Icon";
export { Time } from "./components/Time";
export type { TimeProps } from "./components/Time";

// lib
export { cx, toneClass } from "./lib/cx";
export type { ClassValue, Tone } from "./lib/cx";
export {
  activeTrapRoot,
  hasBlockingLayer,
  isTypingTarget,
  layerDepth,
  OverlayScope,
  tabbableIn,
  topLayer,
  useFocusTrap,
  useLayer,
  useLayerHandle,
  useOverlayOwner,
} from "./lib/layers";
export type { FocusTrapOptions, LayerHandle, OverlayOwner } from "./lib/layers";
export {
  applyStoredTheme,
  applyTheme,
  readThemeMode,
  resolveTheme,
  setThemeMode,
  systemTheme,
  useTheme,
} from "./lib/theme";
export type { Theme, ThemeMode, ThemeState } from "./lib/theme";
export {
  formatDate,
  formatDateTime,
  formatBytes,
  formatDuration,
  formatNumber,
  formatRelative,
  formatTime,
  plural,
  toDate,
  useNow,
} from "./lib/time";
export type { DateLike } from "./lib/time";
export {
  isMac,
  matchesHotkey,
  modKeyLabel,
  paletteShortcutLabel,
  useCommandPaletteHotkey,
  useHotkey,
} from "./lib/hotkeys";
export type { HotkeyOptions } from "./lib/hotkeys";
export { computePosition, useAnchoredPosition } from "./lib/position";
export { readStorage, writeStorage } from "./lib/storage";
export { hasTextSelection, isPlainClick } from "./lib/dom";

export { fitPaneWidths, usePaneResize } from "./lib/panes";
export type { PaneResizeSpec, PaneResizeState, PaneWidth } from "./lib/panes";
export {
  paletteMatchScore,
  filterPaletteItems,
  paletteHighlight,
} from "./lib/paletteSearch";
