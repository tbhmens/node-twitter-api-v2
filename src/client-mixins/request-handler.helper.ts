import { request } from 'https';
import { TwitterApiV2Settings } from '../settings';
import TweetStream from '../stream/TweetStream';
import { ApiRequestError, ApiResponseError } from '../types';
import type { ErrorV1, ErrorV2, TwitterRateLimit, TwitterResponse } from '../types';
import type { TRequestFullData, TRequestFullStreamData } from './request-maker.mixin';
import type { IncomingMessage, ClientRequest } from 'http';

type TRequestReadyPayload = { req: ClientRequest, res: IncomingMessage, requestData: TRequestFullData | TRequestFullStreamData };
type TReadyRequestResolver = (value: TRequestReadyPayload) => void;
type TResponseResolver<T> = (value: TwitterResponse<T>) => void;
type TRequestRejecter = (error: ApiRequestError) => void;
type TResponseRejecter = (error: ApiResponseError) => void;

interface IBuildErrorParams {
  res: IncomingMessage;
  data: any;
  rateLimit?: TwitterRateLimit;
  code: number;
}

export class RequestHandlerHelper<T> {
  protected static readonly FORM_ENCODED_ENDPOINTS = 'https://api.twitter.com/oauth/';
  protected req!: ClientRequest;
  protected responseData = '';

  constructor(protected requestData: TRequestFullData | TRequestFullStreamData) {}

  get href() {
    return this.requestData.url;
  }

  get hrefPathname() {
    const url = new URL(this.requestData.url);
    return url.hostname + url.pathname;
  }

  protected isFormEncodedEndpoint() {
    return this.href.startsWith(RequestHandlerHelper.FORM_ENCODED_ENDPOINTS);
  }

  protected getRateLimitFromResponse(res: IncomingMessage) {
    let rateLimit: TwitterRateLimit | undefined = undefined;

    if (res.headers['x-rate-limit-limit']) {
      rateLimit = {
        limit: Number(res.headers['x-rate-limit-limit']),
        remaining: Number(res.headers['x-rate-limit-remaining']),
        reset: Number(res.headers['x-rate-limit-reset']),
      };
    }

    return rateLimit;
  }

  protected createRequestError(error: Error): ApiRequestError {
    if (TwitterApiV2Settings.debug) {
      console.log('Request network error:', error);
    }

    return new ApiRequestError('Request failed.', {
      request: this.req,
      error,
    });
  }

  protected formatV1Errors(errors: ErrorV1[]) {
    return errors
      .map(({ code, message }) => `${message} (Twitter code ${code})`)
      .join(', ');
  }

  protected formatV2Error(error: ErrorV2) {
    return `${error.title}: ${error.detail} (see ${error.type})`;
  }

  protected createResponseError({ res, data, rateLimit, code }: IBuildErrorParams): ApiResponseError {
    if (TwitterApiV2Settings.debug) {
      console.log('Request failed with code', code, ', data:', data, 'response headers:', res.headers);
    }

    // Errors formatting.
    let errorString = `Request failed with code ${code}`;
    if (data?.errors?.length) {
      const errors = data.errors as (ErrorV1 | ErrorV2)[];

      if ('code' in errors[0]) {
        errorString += ' - ' + this.formatV1Errors(errors as ErrorV1[]);
      }
      else {
        errorString += ' - ' + this.formatV2Error(data as ErrorV2);
      }
    }

    return new ApiResponseError(errorString, {
      code,
      data,
      headers: res.headers,
      request: this.req,
      response: res,
      rateLimit,
    });
  }

  protected getParsedResponse(res: IncomingMessage) {
    let data: any = this.responseData;

    // Auto parse if server responds with JSON body
    if (data.length && res.headers['content-type']?.includes('application/json')) {
      data = JSON.parse(data);
    }
    // f-e oauth token endpoints
    else if (this.isFormEncodedEndpoint()) {
      const response_form_entries: any = {};

      for (const [item, value] of new URLSearchParams(data)) {
        response_form_entries[item] = value;
      }

      data = response_form_entries;
    }

    return data;
  }

  protected registerRequestErrorHandler(reject: TRequestRejecter) {
    return (requestError: Error) => {
      reject(this.createRequestError(requestError));
    };
  }

  protected registerResponseHandler(resolve: TResponseResolver<T>, reject: TResponseRejecter) {
    return (res: IncomingMessage) => {
      const rateLimit = this.getRateLimitFromResponse(res);

      // Register the response data
      res.on('data', chunk => this.responseData += chunk);

      res.on('end', () => {
        const data = this.getParsedResponse(res);

        // Handle bad error codes
        const code = res.statusCode!;
        if (code >= 400) {
          reject(this.createResponseError({ data, res, rateLimit, code }));
        }

        if (TwitterApiV2Settings.debug) {
          console.log(`[${this.requestData.options.method} ${this.hrefPathname}]: Request succeeds with code ${res.statusCode}`);
          console.log('Response body:', data);
        }

        resolve({
          data,
          headers: res.headers,
          rateLimit,
        });
      });
    };
  }

  protected registerStreamResponseHandler(resolve: TReadyRequestResolver, reject: TResponseRejecter) {
    return (res: IncomingMessage) => {
      const code = res.statusCode!;

      if (code < 400) {
        if (TwitterApiV2Settings.debug) {
          console.log(`[${this.requestData.options.method} ${this.hrefPathname}]: Request succeeds with code ${res.statusCode} (starting stream)`);
        }

        // HTTP code ok, consume stream
        resolve({ req: this.req, res, requestData: this.requestData });
      }
      else {
        // Handle response normally, can only rejects
        this.registerResponseHandler(() => undefined, reject)(res);
      }
    };
  }

  protected debugRequest() {
    const url = new URL(this.requestData.url);

    console.log(`[${this.requestData.options.method} ${this.hrefPathname}]`, this.requestData.options);
    if (url.search) {
      console.log('Request parameters:', [...url.searchParams.entries()].map(([key, value]) => `${key}: ${value}`));
    }
    if (this.requestData.body) {
      console.log('Request body:', this.requestData.body);
    }
  }

  protected buildRequest() {
    if (TwitterApiV2Settings.debug) {
      this.debugRequest();
    }
    this.req = request(this.requestData.url, this.requestData.options);
  }

  makeRequest() {
    this.buildRequest();

    return new Promise<TwitterResponse<T>>((resolve, reject) => {
      const req = this.req;

      // Handle request errors
      req.on('error', this.registerRequestErrorHandler(reject));

      req.on('response', this.registerResponseHandler(resolve, reject));

      if (this.requestData.body) {
        req.write(this.requestData.body);
      }

      req.end();
    });
  }

  async makeRequestAsStream() {
    const { req, res, requestData } = await this.makeRequestAndResolveWhenReady();
    return new TweetStream<T>(req, res, requestData as TRequestFullStreamData);
  }

  makeRequestAndResolveWhenReady() {
    this.buildRequest();

    return new Promise<TRequestReadyPayload>((resolve, reject) => {
      const req = this.req;

      // Handle request errors
      req.on('error', this.registerRequestErrorHandler(reject));

      req.on('response', this.registerStreamResponseHandler(resolve, reject));

      if (this.requestData.body) {
        req.write(this.requestData.body);
      }

      req.end();
    });
  }
}

export default RequestHandlerHelper;
