// ==UserScript==
// @name         收看SMGTV电视节目
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  打开网页即可收看SMGTV
// @author       https://github.com/Popukok
// @match        *://*.kankanews.com/huikan
// @match        *://*.kankanews.com/huikan/
// @@icon        https://skin.kankanews.com/kknews/img/pc_logo@2x.png
// @updateURL       https://raw.githubusercontent.com/Popukok/smg_live/edit/main/smg_fivestar.user.js
// @downloadURL     https://raw.githubusercontent.com/Popukok/smg_live/edit/main/smg_fivestar.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 保存原始的XMLHttpRequest.open方法
    const originalOpen = XMLHttpRequest.prototype.open;

    // 重写XMLHttpRequest.open方法
    XMLHttpRequest.prototype.open = function(method, url) {
        // 检查是否是目标API请求
        if (url.includes('https://kapi.kankanews.com/content/pc/tv/')) {
            // 监听readystatechange事件
            this.addEventListener('readystatechange', function() {
                if (this.readyState === 4 && this.status === 200) {
                    try {
                        // 解析响应数据
                        const response = JSON.parse(this.responseText);
                        let modified = false;

                        // 处理单个节目详情接口
                        if (url.includes('/program/detail') && response.result && response.result.is_shield === 1) {
                            response.result.is_shield = 0;
                            modified = true;
                        }

                        // 处理节目列表接口
                        if (url.includes('/programs') && response.result && response.result.programs) {
                            response.result.programs.forEach(program => {
                                if (program.is_shield === 1) {
                                    program.is_shield = 0;
                                    modified = true;
                                }
                            });
                        }

                        if (modified) {
                            // 重写responseText属性
                            Object.defineProperty(this, 'responseText', {
                                value: JSON.stringify(response),
                                writable: false
                            });
                        }
                    } catch (e) {
                        console.error('解析JSON响应时出错:', e);
                    }
                }
            });
        }

        // 调用原始的open方法
        return originalOpen.apply(this, arguments);
    };
})();
