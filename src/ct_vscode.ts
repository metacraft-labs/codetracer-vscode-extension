// requires us to somehow include the `ct_vscode.js` from ct: for now copying it to extension's `out/ct_vscode.js` for development
// maybe there is a more elegant way to include that directly in the source/build?
import * as vscode from "vscode";

// types exported only as types for type checking: no such named objects in actual ct_vscode.js
// functions also exported as actual functions using `module.exports.<function> = <function>;` emitted in `ct_vscode.js`

// this class has emit, subscribe etc methods but mostly availabe in nim for now..
// here used mostly as an opaque type
export interface Mediator {
  name: string;
  transport: any; // not typed here for now
  asSubscriber: any; // not typed here for now
}

// inheriting the Mediator type/class in nim
export interface MediatorWithSubscribers {
  name: string;
  transport: any; // not typed here for now
  asSubscriber: any; // not typed here for now
  subscribers: any[]; // not typed here for now
  handlers: any[]; // not typed here for now
  isRemote: boolean;
}

export interface DapVsCodeApi {
  handlers: any[]; // handler functions, for now not typed here
  context: vscode.ExtensionContext;
  vscode: any; // module vscode
}

export declare function setupVsCodeExtensionViewsApi(
  name: string
): MediatorWithSubscribers;

export declare function newDapVsCodeApi(
  vscode: any,
  context: vscode.ExtensionContext
): DapVsCodeApi;

export declare function setupMiddlewareApis(
  dapApi: DapVsCodeApi,
  viewsApi: MediatorWithSubscribers
): void;

export declare function receive(
  api: MediatorWithSubscribers,
  kind: any, // ct event kind
  rawValue: any,
  subscriber: any // not typed here
): void;
