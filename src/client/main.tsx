import { startApplication } from "./bootstrap";
import { workspacePanelTenants } from "./workspace-panels/registry";

startApplication(workspacePanelTenants);
