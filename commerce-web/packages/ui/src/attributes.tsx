import type { ReactNode } from "react";
import { MediaPicker } from "./media-picker";
type Definition = {
  attribute_code: string;
  label: string;
  input_type: string;
  is_required: boolean;
  options: { value: string; label: string }[];
  metadata?: {status?:string;admin_visible?:boolean;unit?:string|null;min?:number|null;max?:number|null;max_length?:number|null;description?:string};
};
export function AttributeFields({
  definitions,
  values,
  onChange,
  media = [],
  imageUrl,
  mediaLoading = false,
}: {
  definitions: Definition[];
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  media?: { id: string; alt: string }[];
  imageUrl?: (id: string) => string;
  mediaLoading?: boolean;
}) {
  return (
    <div className="form-grid">
      {definitions.filter(d=>d.metadata?.status!=='disabled'&&d.metadata?.admin_visible!==false).map((original) => {
        const d={...original,input_type:({long_text:'textarea',single_select:'select',multi_select:'multiselect'} as Record<string,string>)[original.input_type]??original.input_type};
        const value = values[d.attribute_code];
        const update = (v: unknown) => {
          const next = { ...values };
          if (v === undefined || v === "") delete next[d.attribute_code];
          else next[d.attribute_code] = v;
          onChange(next);
        };
        if (d.input_type === "media_image" && imageUrl) return <MediaPicker key={d.attribute_code} label={d.label} required={d.is_required} value={String(value ?? "")} onChange={update} media={media} imageUrl={imageUrl} loading={mediaLoading} />;
        let field: ReactNode;
        if (d.input_type === "boolean")
          field = (
            <select
              required={d.is_required}
              value={value === undefined ? "" : String(value)}
              onChange={(e) =>
                update(
                  e.target.value === "" ? undefined : e.target.value === "true",
                )
              }
            >
              <option value="">Not set</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          );
        else if (d.input_type === "select" || d.input_type === "multiselect")
          field = (
            <select
              required={d.is_required}
              multiple={d.input_type === "multiselect"}
              value={
                d.input_type === "multiselect"
                  ? Array.isArray(value)
                    ? value.map(String)
                    : []
                  : String(value ?? "")
              }
              onChange={(e) =>
                update(
                  d.input_type === "multiselect"
                    ? Array.from(e.target.selectedOptions, (o) => o.value)
                    : e.target.value,
                )
              }
            >
              {d.input_type === "select" && <option value="">Not set</option>}
              {d.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        else if (d.input_type === "media_image")
          field = (
            <select
              required={d.is_required}
              value={String(value ?? "")}
              onChange={(e) => update(e.target.value)}
            >
              <option value="">No image</option>
              {media.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.alt}
                </option>
              ))}
            </select>
          );
        else if (d.input_type === "textarea")
          field = (
            <textarea
              required={d.is_required}
              maxLength={d.metadata?.max_length??4000}
              value={String(value??"")}
              onChange={e=>update(e.target.value)}
            />
          );
        else
          field = (
            <input
              required={d.is_required}
              type={
                ["price","integer","decimal","measurement"].includes(d.input_type)
                  ? "number"
                  : d.input_type === "date" ? "date" : d.input_type === "datetime" ? "datetime-local" : "text"
              }
              min={d.metadata?.min??(d.input_type === "price" ? 0 : undefined)}
              max={d.metadata?.max??undefined}
              step={d.input_type === "integer" ? "1" : d.input_type === "price" ? "0.01" : "any"}
              maxLength={d.metadata?.max_length??4000}
              value={d.input_type==='datetime'&&value?new Date(new Date(String(value)).getTime()-new Date(String(value)).getTimezoneOffset()*60000).toISOString().slice(0,16):String(value ?? "")}
              onChange={(e) => update(e.target.value===''?undefined:['integer','decimal','measurement'].includes(d.input_type)?Number(e.target.value):d.input_type==='datetime'?new Date(e.target.value).toISOString():e.target.value)}
            />
          );
        return (
          <label className="field" key={d.attribute_code}>
            {d.label}
            {d.is_required ? " *" : ""}{d.metadata?.unit?` (${d.metadata.unit})`:""}
            {field}
            {d.metadata?.description&&<small>{d.metadata.description}</small>}
          </label>
        );
      })}
    </div>
  );
}
