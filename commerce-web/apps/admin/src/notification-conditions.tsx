import { useId } from 'react';
import type { NotificationCondition, NotificationConditionField, NotificationConditions, NotificationPreview } from '@commerce/api-client';
import { conditionFieldAvailable, newNotificationCondition, notificationConditionSummary } from './notification-condition-model';
import './notification-conditions.css';

export function NotificationConditionsEditor({ value, fields, trigger, disabled, onChange }: { value: NotificationConditions; fields: NotificationConditionField[]; trigger: string; disabled: boolean; onChange: (value: NotificationConditions) => void }) {
  const id = useId();
  const available = fields.filter(field => conditionFieldAvailable(field, trigger));
  function change(index: number, rule: NotificationCondition) { onChange({ ...value, rules: value.rules.map((previous, current) => current === index ? rule : previous) }); }
  return <div className="nc-builder">
    <div className="nc-heading"><p>Choose which customers or events qualify.</p><span>{value.rules.length} / 10 conditions</span></div>
    {(value.rules.length > 0 || value.match === 'any') && <div className="nc-match"><label htmlFor={`${id}-match`}>Match</label><select id={`${id}-match`} aria-label="Condition matching" value={value.match} disabled={disabled} onChange={event => onChange({ ...value, match: event.target.value as 'all' | 'any' })}><option value="all">All conditions</option><option value="any">Any condition</option></select><span>{value.match === 'all' ? 'Every condition must pass.' : 'At least one condition must pass.'}</span></div>}
    {value.rules.length === 0 && <div className="nc-empty"><span aria-hidden="true">{value.match === 'any' ? '+' : '✓'}</span><div><strong>{value.match === 'any' ? 'Add a condition to continue' : 'No extra conditions'}</strong><p>{value.match === 'any' ? 'Add a condition or choose All conditions.' : 'Any customer with a matching event can qualify.'}</p></div></div>}
    <ol className="nc-rules">{value.rules.map((rule, index) => {
      const field = fields.find(item => item.key === rule.field);
      const compatible = !!field && conditionFieldAvailable(field, trigger);
      const options = field?.type === 'boolean' && !field.options.length ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : field?.options ?? [];
      return <li key={index} className="nc-rule" data-invalid={!compatible}>
        <div className="nc-rule-fields"><label className="field">{index === 0 ? 'Condition' : value.match === 'all' ? 'And' : 'Or'}<select aria-label={`Condition ${index + 1} field`} value={rule.field} disabled={disabled} onChange={event => { const next = fields.find(item => item.key === event.target.value); if (next) change(index, newNotificationCondition(next)); }}>{!compatible && <option value={rule.field}>{field?.label || rule.field} — unavailable for this event</option>}{available.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
          <label className="field">Comparison<select aria-label={`Condition ${index + 1} operator`} disabled={disabled} value={rule.operator} onChange={event => change(index, { ...rule, operator: event.target.value as NotificationCondition['operator'] })}>{!field?.operators.some(item => item.id === rule.operator) && <option value={rule.operator}>{rule.operator} — unavailable</option>}{field?.operators.map(operator => <option key={operator.id} value={operator.id}>{operator.label}</option>)}</select></label>
          <label className="field">{field?.type === 'money' ? 'Amount' : 'Value'}{field?.type === 'select' || field?.type === 'boolean' ? <select aria-label={`Condition ${index + 1} value`} disabled={disabled} value={rule.value} onChange={event => change(index, { ...rule, value: event.target.value })}>{!options.some(option => option.value === rule.value) && <option value={rule.value}>{rule.value || 'Choose a value'}</option>}{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input aria-label={`Condition ${index + 1} value`} value={rule.value} disabled={disabled} inputMode={field?.type === 'money' ? 'decimal' : field?.type === 'integer' ? 'numeric' : 'text'} placeholder={field?.type === 'money' ? 'e.g. 100.00' : field?.type === 'integer' ? 'e.g. 2' : 'Enter a value'} maxLength={200} onChange={event => change(index, { ...rule, value: rule.field === 'order.currency' ? event.target.value.toUpperCase() : event.target.value })}/>}</label>
          {field?.type === 'money' && <label className="field nc-currency">Currency<input aria-label={`Condition ${index + 1} currency`} placeholder="USD" maxLength={3} value={rule.currency ?? ''} disabled={disabled} onChange={event => change(index, { ...rule, currency: event.target.value.toUpperCase() })}/></label>}
          <button type="button" className="nc-remove" disabled={disabled} aria-label={`Remove condition ${index + 1}`} onClick={() => onChange({ ...value, rules: value.rules.filter((_rule, current) => current !== index) })}>×</button>
        </div>
        {!compatible ? <p className="nc-incompatible" role="alert">This condition does not apply to the selected event. Choose another field or remove it.</p> : <p className="nc-description">{field.description}</p>}
      </li>;
    })}</ol>
    <button className="secondary nc-add" type="button" disabled={disabled || value.rules.length >= 10 || !available.length} onClick={() => onChange({ ...value, rules: [...value.rules, newNotificationCondition(available[0])] })}>+ Add condition</button>
    {!fields.length && <p className="nc-description">Condition fields are unavailable. Existing rules are preserved; refresh configuration to edit them.</p>}
  </div>;
}

export function NotificationConditionResults({ preview, conditions, fields }: { preview: NotificationPreview; conditions: NotificationConditions; fields: NotificationConditionField[] }) {
  if (!conditions.rules.length) return null;
  const results = preview.condition_results ?? [];
  return <section className="nc-results" aria-labelledby="notification-condition-check"><div className="nc-results-heading"><div><h4 id="notification-condition-check">Condition check</h4><p>{conditions.match === 'all' ? 'All conditions must match.' : 'At least one condition must match.'}</p></div>{preview.conditions_matched !== undefined && <span className="nc-result-state" data-passed={preview.conditions_matched}>{preview.conditions_matched ? 'Conditions met' : 'Conditions not met'}</span>}</div>
    {!results.length && <p className="nc-description">Condition results are not available for this preview.</p>}
    <ol>{results.map(result => { const rule = conditions.rules[result.index], field = fields.find(item => item.key === result.field); return <li key={`${result.index}:${result.field}`}><span className="nc-result-icon" data-passed={result.matched} aria-label={result.matched ? 'Passed' : 'Failed'}>{result.matched ? '✓' : '×'}</span><div><strong>{rule ? notificationConditionSummary(rule, fields) : `${field?.label ?? result.field}: ${result.expected}`}</strong><p>Actual: {result.actual === null ? 'Not available' : field?.options.find(option => option.value === result.actual)?.label ?? result.actual}</p>{result.reason && <small>{result.reason}</small>}</div><span className="nc-result-label">{result.matched ? 'Passed' : 'Failed'}</span></li>; })}</ol>
  </section>;
}
