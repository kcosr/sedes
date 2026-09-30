import { useEffect, useState } from "react";
import { getAppearance, setAppearance } from "../../../app/appearance.js";
import {
  DEFAULT_ENVIRONMENT_TINT_SETTINGS,
  ENVIRONMENT_PALETTE_OPTIONS,
  ENVIRONMENT_TINT_COVERAGE_RANGE,
  ENVIRONMENT_TINT_FADE_IN_RANGE,
  ENVIRONMENT_TINT_INTENSITY_RANGE,
  getEnvironmentColorsEnabled,
  getEnvironmentPalette,
  getEnvironmentTintSettings,
  setEnvironmentColorsEnabled,
  setEnvironmentPalette,
  setEnvironmentTintSettings,
  subscribeEnvironmentColorsEnabled,
  subscribeEnvironmentPalette,
  subscribeEnvironmentTintSettings,
  type EnvironmentPaletteId,
  type EnvironmentTintSettings,
} from "../../../app/environment-palette.js";
import {
  getChatAtmosphereEnabled,
  getSmoothStreamingEnabled,
  setChatAtmosphereEnabled,
  setSmoothStreamingEnabled,
  subscribeChatAtmosphereEnabled,
  subscribeSmoothStreamingEnabled,
} from "../../../app/settings.js";
import type { Appearance } from "../../../types.js";
import { Button } from "@client/components/ui/button";
import { useFieldControl } from "@client/components/ui/control";
import { Label } from "@client/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@client/components/ui/radio-group";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";
import { SettingsField, SwitchField } from "../SettingsField.js";
import { SettingsPage } from "../SettingsPage.js";
import { SettingsSection } from "../SettingsSection.js";

const THEMES = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

export function AppearanceSettingsPage(): React.JSX.Element {
  const [appearance, setAppearanceState] = useState<Appearance>(getAppearance);
  const [environmentColorsEnabled, setEnvironmentColorsEnabledState] = useState(
    getEnvironmentColorsEnabled,
  );
  const [environmentPalette, setEnvironmentPaletteState] =
    useState<EnvironmentPaletteId>(getEnvironmentPalette);
  const [tint, setTintState] = useState<EnvironmentTintSettings>(
    getEnvironmentTintSettings,
  );
  const [smoothStreaming, setSmoothStreamingState] = useState(
    getSmoothStreamingEnabled,
  );
  const [chatAtmosphere, setChatAtmosphereState] = useState(
    getChatAtmosphereEnabled,
  );
  useEffect(() => {
    const onChange = () => setAppearanceState(getAppearance());
    window.addEventListener("appearance-change", onChange);
    return () => window.removeEventListener("appearance-change", onChange);
  }, []);
  useEffect(() => subscribeEnvironmentPalette(setEnvironmentPaletteState), []);
  useEffect(
    () => subscribeEnvironmentColorsEnabled(setEnvironmentColorsEnabledState),
    [],
  );
  useEffect(() => subscribeEnvironmentTintSettings(setTintState), []);
  useEffect(() => subscribeSmoothStreamingEnabled(setSmoothStreamingState), []);
  useEffect(() => subscribeChatAtmosphereEnabled(setChatAtmosphereState), []);
  const updateTint = (change: Partial<EnvironmentTintSettings>) => {
    const settings = { ...tint, ...change };
    setTintState(settings);
    setEnvironmentTintSettings(settings);
  };
  const tintIsDefault =
    tint.intensity === DEFAULT_ENVIRONMENT_TINT_SETTINGS.intensity &&
    tint.fadeIn === DEFAULT_ENVIRONMENT_TINT_SETTINGS.fadeIn &&
    tint.coverage === DEFAULT_ENVIRONMENT_TINT_SETTINGS.coverage;
  const tintDisabled = !environmentColorsEnabled;

  return (
    <SettingsPage
      title="Appearance"
      description="Theme, environment colors and motion in this browser."
    >
      <SettingsSection title="Display" card>
        <SettingsField
          label="Theme"
          description="Follow the system appearance, or force light or dark."
        >
          <SegmentedControl
            className="w-full"
            value={appearance}
            onValueChange={(next) => {
              const value = next as Appearance;
              setAppearanceState(value);
              setAppearance(value);
            }}
          >
            {THEMES.map(([value, label]) => (
              <SegmentedControlItem key={value} value={value}>
                {label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </SettingsField>
        <SwitchField
          id="setting-chat-atmosphere"
          label="Animated chat background"
          description="Draw a subtle animated point field behind conversations. Reduce Motion always disables this effect."
          checked={chatAtmosphere}
          onCheckedChange={(next) => {
            setChatAtmosphereState(next);
            setChatAtmosphereEnabled(next);
          }}
          switchProps={{ "data-testid": "chat-atmosphere-toggle" }}
        />
        <SwitchField
          id="setting-smooth-streaming"
          label="Smooth streaming"
          description="Fade in new response text and ease live-edge following. If your system's Reduce Motion preference is on, updates appear without these animations."
          checked={smoothStreaming}
          onCheckedChange={(next) => {
            setSmoothStreamingState(next);
            setSmoothStreamingEnabled(next);
          }}
          switchProps={{ "data-testid": "smooth-streaming-toggle" }}
        />
      </SettingsSection>
      <SettingsSection
        title="Environment colors"
        description="Colors are evenly distributed from the complete configured environment list without storing individual assignments."
        card
      >
        <SwitchField
          id="setting-environment-colors-enabled"
          label="Show environment colors"
          description="Tint sidebar rows and headers to tell execution environments apart."
          checked={environmentColorsEnabled}
          onCheckedChange={(enabled) => {
            setEnvironmentColorsEnabledState(enabled);
            setEnvironmentColorsEnabled(enabled);
          }}
          switchProps={{ "data-testid": "environment-colors-enabled-toggle" }}
        />
        <SettingsField
          className="settings-tint-field"
          label="Palette"
          description="The hues environments are drawn from."
          disabled={tintDisabled}
        >
          <FieldRadioGroup
            className="settings-palette-group"
            value={environmentPalette}
            disabled={tintDisabled}
            onValueChange={(next) => {
              const palette = next as EnvironmentPaletteId;
              setEnvironmentPaletteState(palette);
              setEnvironmentPalette(palette);
            }}
          >
            {ENVIRONMENT_PALETTE_OPTIONS.map((option) => (
              <div className="settings-palette-option" key={option.id}>
                <RadioGroupItem
                  value={option.id}
                  id={`setting-environment-palette-${option.id}`}
                />
                <Label
                  className="settings-palette-label"
                  htmlFor={`setting-environment-palette-${option.id}`}
                  title={option.description}
                >
                  <span>{option.label}</span>
                  <span className="settings-palette-preview" aria-hidden="true">
                    {Array.from(
                      { length: 4 },
                      (_, index) => (option.rotation + index * 90) % 360,
                    ).map((hue) => (
                      <span
                        key={hue}
                        style={
                          {
                            "--environment-hue": hue,
                            "--environment-chroma": option.chroma,
                          } as React.CSSProperties
                        }
                      />
                    ))}
                  </span>
                </Label>
              </div>
            ))}
          </FieldRadioGroup>
        </SettingsField>
        <TintSlider
          id="setting-environment-intensity"
          label="Intensity"
          description="Sets the peak opacity; the softer tail follows at one third."
          value={tint.intensity}
          range={ENVIRONMENT_TINT_INTENSITY_RANGE}
          disabled={tintDisabled}
          output={`${tint.intensity}% → ${Math.round(tint.intensity / 3)}%`}
          valueText={`${tint.intensity}% peak opacity and ${Math.round(tint.intensity / 3)}% trailing opacity`}
          onChange={(intensity) => updateTint({ intensity })}
        />
        <TintSlider
          id="setting-environment-fade-in"
          label="Row fade-in"
          description="Sets how gradually each row tint reaches full intensity. A single selected environment starts at full intensity at the sidebar edge."
          value={tint.fadeIn}
          range={ENVIRONMENT_TINT_FADE_IN_RANGE}
          disabled={tintDisabled}
          output={`${tint.fadeIn}%`}
          valueText={`${tint.fadeIn}% row fade-in distance`}
          onChange={(fadeIn) => updateTint({ fadeIn })}
        />
        <TintSlider
          id="setting-environment-coverage"
          label="Coverage"
          description="Sets where each row tint becomes fully transparent."
          value={tint.coverage}
          range={ENVIRONMENT_TINT_COVERAGE_RANGE}
          disabled={tintDisabled}
          output={`${tint.coverage}%`}
          valueText={`Rows fully clear by ${tint.coverage}%`}
          onChange={(coverage) => updateTint({ coverage })}
        />
        <div className="settings-tint-reset">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={tintDisabled || tintIsDefault}
            onClick={() => {
              setTintState(DEFAULT_ENVIRONMENT_TINT_SETTINGS);
              setEnvironmentTintSettings(DEFAULT_ENVIRONMENT_TINT_SETTINGS);
            }}
          >
            Reset tint controls
          </Button>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

function TintSlider({
  id,
  label,
  description,
  value,
  range,
  disabled,
  output,
  valueText,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly value: number;
  readonly range: { readonly min: number; readonly max: number; readonly step: number };
  readonly disabled: boolean;
  readonly output: string;
  readonly valueText: string;
  readonly onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <SettingsField
      className="settings-tint-field"
      id={id}
      label={label}
      description={description}
      disabled={disabled}
    >
      <div className="settings-slider">
        <RangeInput
          className="settings-slider-input"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          aria-valuetext={valueText}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
        <output htmlFor={id} className="settings-slider-value">
          {output}
        </output>
      </div>
    </SettingsField>
  );
}

/** A radio group named and described by its settings row. */
function FieldRadioGroup(
  props: React.ComponentProps<typeof RadioGroup>,
): React.JSX.Element {
  return <RadioGroup {...useFieldControl(props, { labelledBy: true })} />;
}

/** A range input named and described by its settings row. */
function RangeInput(
  props: Omit<React.ComponentProps<"input">, "type">,
): React.JSX.Element {
  return <input type="range" {...useFieldControl(props)} />;
}
