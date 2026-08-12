import { take_snapshot } from './snapshotTools';
import { click, hover, fill, fill_form, type_text, press_key } from './actionTools';
import { navigate_page, new_page, list_pages, select_page, close_page, wait_for } from './navigationTools';
import { evaluate_script } from './evaluateTool';
import { take_screenshot } from './screenshotTool';
import { list_console_messages, get_console_message } from './consoleTools';
import { list_network_requests, get_network_request } from './networkTools';
import { update_task_ledger } from './ledgerTools';
import { extract_content } from './extractTool';
import { infer_row_schema, extract_rows } from './tableTools';
import { web_search } from './searchTool';
import { control_task, CONTROL_TASK_TOOL } from './controlTools';

export const tools = {
  take_snapshot,
  extract_content,
  infer_row_schema,
  extract_rows,
  web_search,
  click,
  hover,
  fill,
  fill_form,
  type_text,
  press_key,
  navigate_page,
  new_page,
  list_pages,
  select_page,
  close_page,
  wait_for,
  evaluate_script,
  take_screenshot,
  list_console_messages,
  get_console_message,
  list_network_requests,
  get_network_request,
  update_task_ledger,
  control_task,
};

/** Ends the current root or episode loop so the orchestrator can interpret it. */
export { CONTROL_TASK_TOOL };
