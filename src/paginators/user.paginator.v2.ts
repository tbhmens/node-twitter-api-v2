import { ApiV2Includes, TwitterResponse, UserV2, UserV2TimelineParams, UserV2TimelineResult } from '../types';
import { PreviousableTwitterPaginator } from './TwitterPaginator';

/** A generic PreviousableTwitterPaginator able to consume UserV2 timelines. */
abstract class UserTimelineV2Paginator<
  TResult extends UserV2TimelineResult,
  TParams extends UserV2TimelineParams,
  TShared = any,
> extends PreviousableTwitterPaginator<TResult, TParams, UserV2, TShared> {
  protected refreshInstanceFromResult(response: TwitterResponse<TResult>, isNextPage: boolean) {
    const result = response.data;
    const resultData = result.data ?? [];
    this._rateLimit = response.rateLimit!;

    if (!this._realData.data) {
      this._realData.data = [];
    }

    if (isNextPage) {
      this._realData.meta.result_count += result.meta.result_count;
      this._realData.meta.next_token = result.meta.next_token;
      this._realData.data.push(...resultData);
    }
    else {
      this._realData.meta.result_count += result.meta.result_count;
      this._realData.meta.previous_token = result.meta.previous_token;
      this._realData.data.unshift(...resultData);
    }

    this.updateIncludes(result);
  }

  protected updateIncludes(data: TResult) {
    if (!data.includes) {
      return;
    }
    if (!this._realData.includes) {
      this._realData.includes = {};
    }

    const includesRealData = this._realData.includes;

    for (const [includeKey, includeArray] of Object.entries(data.includes) as [keyof ApiV2Includes, any[]][]) {
      if (!includesRealData[includeKey]) {
        includesRealData[includeKey] = [];
      }

      includesRealData[includeKey] = [
        ...includesRealData[includeKey]!,
        ...includeArray,
      ];
    }
  }

  protected getNextQueryParams(maxResults?: number) {
    return {
      ...this._queryParams,
      pagination_token: this._realData.meta.next_token,
      ...(maxResults ? { max_results: maxResults } : {}),
    };
  }

  protected getPreviousQueryParams(maxResults?: number) {
    return {
      ...this._queryParams,
      pagination_token: this._realData.meta.previous_token,
      ...(maxResults ? { max_results: maxResults } : {}),
    };
  }

  protected getPageLengthFromRequest(result: TwitterResponse<TResult>) {
    return result.data.data?.length ?? 0;
  }

  protected isFetchLastOver(result: TwitterResponse<TResult>) {
    return !result.data.data?.length || !result.data.meta.next_token;
  }

  protected getItemArray() {
    return this.users;
  }

  /**
   * Users returned by paginator.
   */
  get users() {
    return this._realData.data ?? [];
  }

  get meta() {
    return this._realData.meta;
  }

  get includes() {
    return this._realData.includes ?? {};
  }
}

export class UserBlockingUsersV2Paginator extends UserTimelineV2Paginator<UserV2TimelineResult, UserV2TimelineParams, { userId: string }> {
  protected _endpoint = 'users/:id/blocking';

  protected getEndpoint() {
    return this._endpoint.replace(':id', this._sharedParams.userId);
  }
}

export class UserFollowersV2Paginator extends UserTimelineV2Paginator<UserV2TimelineResult, UserV2TimelineParams, { userId: string }> {
  protected _endpoint = 'users/:id/followers';

  protected getEndpoint() {
    return this._endpoint.replace(':id', this._sharedParams.userId);
  }
}

export class UserFollowingV2Paginator extends UserTimelineV2Paginator<UserV2TimelineResult, UserV2TimelineParams, { userId: string }> {
  protected _endpoint = 'users/:id/following';

  protected getEndpoint() {
    return this._endpoint.replace(':id', this._sharedParams.userId);
  }
}
