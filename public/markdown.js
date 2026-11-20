/**
 * 极简 Markdown 渲染器（无依赖、先转义后渲染，杜绝 XSS）
 * 支持：标题、粗体/斜体/删除线、行内代码、代码块、列表、引用、分割线、安全链接。
 */
(function (global) {
  'use strict';

  var ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(input) {
    return String(input == null ? '' : input).replace(/[&<>"']/g, function (ch) {
      return ESCAPES[ch];
    });
  }

  function renderCodeBlock(block) {
    var lang = block.lang ? escapeHtml(block.lang) : 'code';
    return (
      '<pre><div class="code-bar"><span>' +
      lang +
      '</span><button class="copy-code" type="button">复制</button></div><code>' +
      escapeHtml(block.code) +
      '</code></pre>'
    );
  }

  function renderMarkdown(source) {
    var blocks = [];
    var inlines = [];
    var text = String(source == null ? '' : source).replace(/\r\n?/g, '\n');

    // 1. 先把围栏代码块摘出来，避免其中的符号被当成格式
    text = text.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, function (_, lang, code) {
      var index = blocks.length;
      blocks.push({ lang: String(lang || '').trim(), code: code.replace(/\n$/, '') });
      return '\uE000B' + index + '\uE001';
    });

    // 2. 全文转义
    text = escapeHtml(text);

    // 3. 行内代码
    text = text.replace(/`([^`\n]+)`/g, function (_, code) {
      var index = inlines.length;
      inlines.push(code);
      return '\uE000I' + index + '\uE001';
    });

    // 4. 行内格式（在转义之后，安全）
    text = text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      );

    // 5. 逐行分块
    var lines = text.split('\n');
    var html = [];
    var paragraph = [];
    var listTag = null;
    var listItems = [];

    function closeParagraph() {
      if (paragraph.length) {
        html.push('<p>' + paragraph.join('<br>') + '</p>');
        paragraph = [];
      }
    }
    function closeList() {
      if (listTag) {
        html.push('<' + listTag + '>' + listItems.join('') + '</' + listTag + '>');
        listTag = null;
        listItems = [];
      }
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].replace(/\s+$/, '');

      if (!line.trim()) {
        closeParagraph();
        closeList();
        continue;
      }

      var codeMatch = line.match(/^\uE000B(\d+)\uE001$/);
      if (codeMatch) {
        closeParagraph();
        closeList();
        html.push(renderCodeBlock(blocks[Number(codeMatch[1])]));
        continue;
      }

      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeParagraph();
        closeList();
        var level = heading[1].length;
        html.push('<h' + level + '>' + heading[2] + '</h' + level + '>');
        continue;
      }

      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        closeParagraph();
        closeList();
        html.push('<hr>');
        continue;
      }

      // 注意：此处文本已转义，行首的 ">" 会变成 "&gt;"
      if (/^&gt;\s?/.test(line)) {
        closeParagraph();
        closeList();
        html.push('<blockquote>' + line.replace(/^&gt;\s?/, '') + '</blockquote>');
        continue;
      }

      var unordered = line.match(/^\s*[-*+]\s+(.*)$/);
      var ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (unordered || ordered) {
        closeParagraph();
        var wanted = ordered ? 'ol' : 'ul';
        if (listTag && listTag !== wanted) closeList();
        listTag = wanted;
        listItems.push('<li>' + (unordered ? unordered[1] : ordered[1]) + '</li>');
        continue;
      }

      closeList();
      paragraph.push(line);
    }
    closeParagraph();
    closeList();

    var output = html.join('');

    // 6. 还原占位符
    output = output.replace(/\uE000B(\d+)\uE001/g, function (_, index) {
      return renderCodeBlock(blocks[Number(index)]);
    });
    output = output.replace(/\uE000I(\d+)\uE001/g, function (_, index) {
      return '<code>' + inlines[Number(index)] + '</code>';
    });

    return output;
  }

  global.DSMarkdown = { render: renderMarkdown, escapeHtml: escapeHtml };
})(window);
