// ==UserScript==
// @name         看看新闻节目详情修改器
// @namespace    http://tampermonkey.net/
// @version      0.4
// @description  拦截节目详情API请求，将is_shield值为1的修改为0
// @author       You
// @match        https://live.kankanews.com/huikan
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 统一处理节目列表响应数据
    function processProgramsResponse(response) {
        try {
            // 修改programs数组中所有项的is_shield值为0
            if (response.result && response.result.programs && Array.isArray(response.result.programs)) {
                response.result.programs.forEach(program => {
                    if (program.is_shield === 1) {
                        program.is_shield = 0;
                    }
                });
            }
            return response;
        } catch (e) {
            console.error('处理节目列表数据时出错:', e);
            return response;
        }
    }

    // 统一处理节目详情响应数据
    function processProgramDetailResponse(response) {
        try {
            // 如果is_shield值为1，则修改为0
            if (response.result && response.result.is_shield === 1) {
                response.result.is_shield = 0;
            }
            return response;
        } catch (e) {
            console.error('处理节目详情数据时出错:', e);
            return response;
        }
    }

    // 判断是否为目标节目列表URL
    function isProgramsUrl(url) {
        return typeof url === 'string' && 
               url.startsWith('https://kapi.kankanews.com/content/pc/tv/programs?') &&
               url.includes('channel_id') && 
               url.includes('date');
    }

    // 判断是否为目标节目详情URL
    function isProgramDetailUrl(url) {
        return typeof url === 'string' && 
               url.startsWith('https://kapi.kankanews.com/content/pc/tv/program/detail?') &&
               url.includes('channel_program_id');
    }

    // 保存原始的XMLHttpRequest对象
    const xhr = window.XMLHttpRequest;
    const origOpen = xhr.prototype.open;
    const origSend = xhr.prototype.send;

    // 拦截XMLHttpRequest请求
    xhr.prototype.open = function(method, url) {
        this._url = url;
        return origOpen.apply(this, arguments);
    };

    xhr.prototype.send = function() {
        // 处理节目列表请求
        if (isProgramsUrl(this._url)) {
            const origOnReadyStateChange = this.onreadystatechange;

            this.onreadystatechange = function() {
                if (this.readyState === 4 && this.status === 200) {
                    try {
                        // 解析响应JSON
                        let response = JSON.parse(this.responseText);
                        // 处理响应数据
                        response = processProgramsResponse(response);
                        
                        // 修改响应文本
                        Object.defineProperty(this, 'responseText', {writable: true});
                        this.responseText = JSON.stringify(response);
                    } catch (e) {
                        console.error('解析节目列表JSON时出错:', e);
                    }
                }

                // 调用原始的onreadystatechange
                if (origOnReadyStateChange) {
                    origOnReadyStateChange.apply(this, arguments);
                }
            };
        }
        // 处理节目详情请求
        else if (isProgramDetailUrl(this._url)) {
            const origOnReadyStateChange = this.onreadystatechange;

            this.onreadystatechange = function() {
                if (this.readyState === 4 && this.status === 200) {
                    try {
                        // 解析响应JSON
                        let response = JSON.parse(this.responseText);
                        // 处理响应数据
                        response = processProgramDetailResponse(response);
                        
                        // 修改响应文本
                        Object.defineProperty(this, 'responseText', {writable: true});
                        this.responseText = JSON.stringify(response);
                    } catch (e) {
                        console.error('解析节目详情JSON时出错:', e);
                    }
                }

                // 调用原始的onreadystatechange
                if (origOnReadyStateChange) {
                    origOnReadyStateChange.apply(this, arguments);
                }
            };
        }

        return origSend.apply(this, arguments);
    };

    // 拦截fetch请求
    const origFetch = window.fetch;
    window.fetch = function() {
        const url = arguments[0];
        const options = arguments[1];

        // 处理节目列表请求
        if (isProgramsUrl(url)) {
            return origFetch.apply(this, arguments).then(response => {
                const origJson = response.json;
                response.json = function() {
                    return origJson.apply(this, arguments).then(data => {
                        return processProgramsResponse(data);
                    });
                };
                return response;
            });
        }
        // 处理节目详情请求
        else if (isProgramDetailUrl(url)) {
            return origFetch.apply(this, arguments).then(response => {
                const origJson = response.json;
                response.json = function() {
                    return origJson.apply(this, arguments).then(data => {
                        return processProgramDetailResponse(data);
                    });
                };
                return response;
            });
        }

        return origFetch.apply(this, arguments);
    };
})();