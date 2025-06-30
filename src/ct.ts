// requires us to somehow include the `ct_vscode.js` from ct
import * as vscode from "vscode";

// has emit, subscribe etc methods but mostly availabe in nim for now..
// here used mostly as an opaque type
export interface Mediator {
  name: string;
}

export interface VsCodeDapApi {
  context: vscode.ExtensionContext;
  vscode: any; // module vscode
}

export declare function setupVsCodeExtensionViewsApi(name: string): Mediator;

export declare function newVsCodeDap(
  context: vscode.ExtensionContext
): VsCodeDapApi;

export declare function setupVsCodeBackendApi(
  name: string,
  dapApi: VsCodeDapApi,
  viewsApi: Mediator
): Mediator;
