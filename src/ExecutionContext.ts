/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { helper, assert } from './helper';
import { createJSHandle, JSHandle, ElementHandle } from './JSHandle';
import { CDPSession } from './Connection';
import { DOMWorld } from './DOMWorld';
import { Frame } from './FrameManager';
import Protocol from './protocol';

export const EVALUATION_SCRIPT_URL = '__puppeteer_evaluation_script__';
const SOURCE_URL_REGEX = /^[\040\t]*\/\/[@#] sourceURL=\s*(\S*?)\s*$/m;

export class ExecutionContext {
  _client: CDPSession;
  _world: DOMWorld;
  _contextId: number;

  constructor(
    client: CDPSession,
    contextPayload: Protocol.Runtime.ExecutionContextDescription,
    world: DOMWorld
  ) {
    this._client = client;
    this._world = world;
    this._contextId = contextPayload.id;
  }

  frame(): Frame | null {
    return this._world ? this._world.frame() : null;
  }

  async evaluate<ReturnType extends any>(
    pageFunction: Function | string,
    ...args: unknown[]
  ): Promise<ReturnType> {
    return await this._evaluateInternal<ReturnType>(
      true,
      pageFunction,
      ...args
    );
  }

  async evaluateHandle(
    pageFunction: Function | string,
    ...args: unknown[]
  ): Promise<JSHandle> {
    return this._evaluateInternal<JSHandle>(false, pageFunction, ...args);
  }

  private async _evaluateInternal<ReturnType>(
    returnByValue,
    pageFunction: Function | string,
    ...args: unknown[]
  ): Promise<ReturnType> {
    const suffix = `//# sourceURL=${EVALUATION_SCRIPT_URL}`;

    if (helper.isString(pageFunction)) {
      const contextId = this._contextId;
      const expression = pageFunction;
      const expressionWithSourceUrl = SOURCE_URL_REGEX.test(expression)
        ? expression
        : expression + '\n' + suffix;

      const { exceptionDetails, result: remoteObject } = await this._client
        .send('Runtime.evaluate', {
          expression: expressionWithSourceUrl,
          contextId,
          returnByValue,
          awaitPromise: true,
          userGesture: true,
        })
        .catch(rewriteError);

      if (exceptionDetails)
        throw new Error(
          'Evaluation failed: ' + helper.getExceptionMessage(exceptionDetails)
        );

      return returnByValue
        ? helper.valueFromRemoteObject(remoteObject)
        : createJSHandle(this, remoteObject);
    }

    if (typeof pageFunction !== 'function')
      throw new Error(
        `Expected to get |string| or |function| as the first argument, but got "${pageFunction}" instead.`
      );

    let functionText = pageFunction.toString();
    try {
      new Function('(' + functionText + ')');
    } catch (error) {
      // This means we might have a function shorthand. Try another
      // time prefixing 'function '.
      if (functionText.startsWith('async '))
        functionText =
          'async function ' + functionText.substring('async '.length);
      else functionText = 'function ' + functionText;
      try {
        new Function('(' + functionText + ')');
      } catch (error) {
        // We tried hard to serialize, but there's a weird beast here.
        throw new Error('Passed function is not well-serializable!');
      }
    }
    let callFunctionOnPromise;
    try {
      callFunctionOnPromise = this._client.send('Runtime.callFunctionOn', {
        functionDeclaration: functionText + '\n' + suffix + '\n',
        executionContextId: this._contextId,
        arguments: args.map(convertArgument.bind(this)),
        returnByValue,
        awaitPromise: true,
        userGesture: true,
      });
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message.startsWith('Converting circular structure to JSON')
      )
        error.message += ' Are you passing a nested JSHandle?';
      throw error;
    }
    const {
      exceptionDetails,
      result: remoteObject,
    } = await callFunctionOnPromise.catch(rewriteError);
    if (exceptionDetails)
      throw new Error(
        'Evaluation failed: ' + helper.getExceptionMessage(exceptionDetails)
      );
    return returnByValue
      ? helper.valueFromRemoteObject(remoteObject)
      : createJSHandle(this, remoteObject);

    /**
     * @param {*} arg
     * @return {*}
     * @this {ExecutionContext}
     */
    function convertArgument(this: ExecutionContext, arg: unknown): unknown {
      if (typeof arg === 'bigint')
        // eslint-disable-line valid-typeof
        return { unserializableValue: `${arg.toString()}n` };
      if (Object.is(arg, -0)) return { unserializableValue: '-0' };
      if (Object.is(arg, Infinity)) return { unserializableValue: 'Infinity' };
      if (Object.is(arg, -Infinity))
        return { unserializableValue: '-Infinity' };
      if (Object.is(arg, NaN)) return { unserializableValue: 'NaN' };
      const objectHandle = arg && arg instanceof JSHandle ? arg : null;
      if (objectHandle) {
        if (objectHandle._context !== this)
          throw new Error(
            'JSHandles can be evaluated only in the context they were created!'
          );
        if (objectHandle._disposed) throw new Error('JSHandle is disposed!');
        if (objectHandle._remoteObject.unserializableValue)
          return {
            unserializableValue: objectHandle._remoteObject.unserializableValue,
          };
        if (!objectHandle._remoteObject.objectId)
          return { value: objectHandle._remoteObject.value };
        return { objectId: objectHandle._remoteObject.objectId };
      }
      return { value: arg };
    }

    function rewriteError(error: Error): Protocol.Runtime.evaluateReturnValue {
      if (error.message.includes('Object reference chain is too long'))
        return { result: { type: 'undefined' } };
      if (error.message.includes("Object couldn't be returned by value"))
        return { result: { type: 'undefined' } };

      if (
        error.message.endsWith('Cannot find context with specified id') ||
        error.message.endsWith('Inspected target navigated or closed')
      )
        throw new Error(
          'Execution context was destroyed, most likely because of a navigation.'
        );
      throw error;
    }
  }

  async queryObjects(prototypeHandle: JSHandle): Promise<JSHandle> {
    assert(!prototypeHandle._disposed, 'Prototype JSHandle is disposed!');
    assert(
      prototypeHandle._remoteObject.objectId,
      'Prototype JSHandle must not be referencing primitive value'
    );
    const response = await this._client.send('Runtime.queryObjects', {
      prototypeObjectId: prototypeHandle._remoteObject.objectId,
    });
    return createJSHandle(this, response.objects);
  }

  async _adoptBackendNodeId(
    backendNodeId: Protocol.DOM.BackendNodeId
  ): Promise<ElementHandle> {
    const { object } = await this._client.send('DOM.resolveNode', {
      backendNodeId: backendNodeId,
      executionContextId: this._contextId,
    });
    return createJSHandle(this, object) as ElementHandle;
  }

  async _adoptElementHandle(
    elementHandle: ElementHandle
  ): Promise<ElementHandle> {
    assert(
      elementHandle.executionContext() !== this,
      'Cannot adopt handle that already belongs to this execution context'
    );
    assert(this._world, 'Cannot adopt handle without DOMWorld');
    const nodeInfo = await this._client.send('DOM.describeNode', {
      objectId: elementHandle._remoteObject.objectId,
    });
    return this._adoptBackendNodeId(nodeInfo.node.backendNodeId);
  }
}
