//@require bootstrap/css/bootstrap.css
//@require ui-autocomplete.css
var pinyin = require("pinyin");

angular.module("ui.autocomplete.tpls", []).run(["$templateCache", function($templateCache) {
  $templateCache.put("template/autocomplete/autocomplete-match.html",
    "<a tabindex=\"-1\" bind-html-unsafe=\"match.label | autocompleteHighlight:query\"></a>");

  $templateCache.put("template/autocomplete/autocomplete-popup.html",
    "<ul class=\"dropdown-menu\" ng-class=\"popupClass\" ng-style=\"{display: isOpen()&&'block' || 'none', top: position.top+'px', left: position.left+'px'}\">\n" +
    "    <li ng-repeat=\"match in matches track by $index\" ng-class=\"{active: isActive($index) }\" ng-mouseenter=\"selectActive($index)\" ng-click=\"selectMatch($index)\">\n" +
    "        <div autocomplete-match index=\"$index\" match=\"match\" query=\"query\" template-url=\"templateUrl\"></div>\n" +
    "    </li>\n" +
    "</ul>");

  $templateCache.put("template/autocomplete/autocomplete.html",
    "<ul class=\"autocomplete dropdown-menu\" ng-style=\"{display: isOpen()&&'block' || 'none', top: position.top+'px', left: position.left+'px'}\">\n" +
    "    <li ng-repeat=\"match in matches track by $index\" ng-class=\"{active: isActive($index) }\" ng-click=\"selectMatch($index)\" ng-mouseenter=\"selectActive($index)\">\n" +
    "        <a tabindex=\"-1\" ng-bind-html-unsafe=\"match.label | autocompleteHighlight:query\"></a>\n" +
    "    </li>\n" +
    "</ul>");

   $templateCache.put("template/autocomplete/autocomplete-pinyin.html",
    "<a class=\"clearfix\" style=\"*zoom:0\"><span style=\"float:left;*float:none;\" bind-html-unsafe=\"match.label | autocompleteHighlight:query\"></span>"+
    "<span style=\"float:right;*float:none;padding-left:20px\" bind-html-unsafe=\"match.label | pinyin:'f' | autocompleteHighlight:query\"></span></a>");
}])

.directive('bindHtmlUnsafe', function () {
  return function (scope, element, attr) {
    element.addClass('ng-binding').data('$binding', attr.bindHtmlUnsafe);
    scope.$watch(attr.bindHtmlUnsafe, function bindHtmlUnsafeWatchAction(value) {
      element.html(value || '');
    });
  };
});

angular.module("ui.autocomplete", ['ui.autocomplete.tpls'])

/**
 * 当点击触发下拉框显示的时候利用'非'包含字符串不过滤数据源
 */
.constant('$$__nofilter','!~@#$%^&*()')

/**
 * A helper service that can parse autocomplete's syntax (string provided by users)
 * Extracted to a separate service for ease of unit testing
 */
  .factory('autocompleteParser', ['$parse', function ($parse) {

  //                      00000111000000000000022200000000000000003333333333333330000000000044000
  var autocomplete_REGEXP = /^\s*(.*?)(?:\s+as\s+(.*?))?\s+for\s+(?:([\$\w][\$\w\d]*))\s+in\s+(.*)$/;

  return {
    parse:function (input) {

      var match = input.match(autocomplete_REGEXP), modelMapper, viewMapper, source;
      if (!match) {
        throw new Error(
          "Expected autocomplete specification in form of '_modelValue_ (as _label_)? for _item_ in _collection_'" +
            " but got '" + input + "'.");
      }

      return {
        itemName:match[3],
        source:$parse(match[4]),
        sourceText:match[4].replace(/\s*/g,""),
        viewMapper:$parse(match[2] || match[1]),
        modelMapper:$parse(match[1]),
        noLimitSource:$parse(match[4].split("|")[0])
      };
    }
  };
}])

  .directive('autocomplete', ['$compile', '$parse', '$q', '$timeout', '$window', '$document', '$position', 'autocompleteParser', '$filter', '$$__nofilter',
    function ($compile, $parse, $q, $timeout, $window, $document, $position, autocompleteParser, $filter, __nofilter) {

  var HOT_KEYS = [9, 13, 27, 38, 40];

  return {
    require:'ngModel',
    link:function (originalScope, element, attrs, modelCtrl) {

      //SUPPORTED ATTRIBUTES (OPTIONS)

      //minimal no of characters that needs to be entered before autocomplete kicks-in
      var minSearch = originalScope.$eval(attrs.autocompleteMinLength) || 1;

      //minimal wait time after last character typed before typehead kicks-in
      var waitTime = originalScope.$eval(attrs.autocompleteWaitMs) || 0;

      //should it restrict model values to the ones selected from the popup only?
      var isEditable = originalScope.$eval(attrs.autocompleteEditable) !== false;

      //binding to a variable that indicates if matches are being retrieved asynchronously
      var isLoadingSetter = $parse(attrs.autocompleteLoading).assign || angular.noop;

      //a callback executed when a match is selected
      var onSelectCallback = $parse(attrs.autocompleteOnSelect);

      var inputFormatter = attrs.autocompleteInputFormatter ? $parse(attrs.autocompleteInputFormatter) : undefined;

      var appendToBody = attrs.autocompleteAppendToBody ? $parse(attrs.autocompleteAppendToBody) : false;

      var clickLoad = originalScope.$eval(attrs.autocompleteClickLoad) !== false;

      //INTERNAL VARIABLES

      //model setter executed upon match selection
      var $setModelValue = $parse(attrs.ngModel).assign;

      //expressions used by autocomplete
      var parserResult = autocompleteParser.parse(attrs.autocomplete);

      var hasFocus;

      //pop-up element used to display matches
      var popUpEl = angular.element('<div autocomplete-popup></div>');
      popUpEl.attr({
        matches: 'matches',
        active: 'activeIdx',
        select: 'select(activeIdx)',
        query: 'query',
        position: 'position'
      });

 	   if(attrs.autocompletePinyin){
      		attrs.autocompleteTemplateUrl = "template/autocomplete/autocomplete-pinyin.html"
      }

      //custom item template
      if (angular.isDefined(attrs.autocompleteTemplateUrl)) {
        popUpEl.attr('template-url', attrs.autocompleteTemplateUrl);
      }

      //custom popup class
      if (angular.isDefined(attrs.autocompletePopupClass)) {
        popUpEl.attr('popup-class', attrs.autocompletePopupClass);
      }

      //create a child scope for the autocomplete directive so we are not polluting original scope
      //with autocomplete-specific data (matches, query etc.)
      var scope = originalScope.$new();
      originalScope.$on('$destroy', function(){
        scope.$destroy();
      });

      var resetMatches = function() {
        scope.matches = [];
        scope.activeIdx = -1;
      };

      var getMatchesAsync = function(inputValue) {

        var locals = {$viewValue:inputValue};
        if(inputValue == __nofilter && parserResult.sourceText.indexOf('($viewValue)') != -1)
          locals.$viewValue = undefined;

        if(attrs.autocompletePinyin){
          //增加拼音内容,用于搜索匹配
          var locals, label, source = parserResult.noLimitSource(originalScope);
          if(source){
            for(var i=source.length;i>=0;i--){
              if(angular.isObject(source[i])){
                locals[parserResult.itemName] = source[i];
                label = parserResult.viewMapper(scope, locals);
                source[i].__pinyin = $filter("pinyin")(label, 'a');
              }
            }
          }
        }
        
        isLoadingSetter(originalScope, true);
        $q.when(parserResult.source(originalScope, locals)).then(function(matches) {

          //it might happen that several async queries were in progress if a user were typing fast
          //but we are interested only in responses that correspond to the current view value
          if ((angular.equals(inputValue, __nofilter) || inputValue === modelCtrl.$viewValue) && hasFocus) {
            if (matches.length > 0) {

              scope.activeIdx = 0;
              scope.matches.length = 0;

              //transform labels
              for(var i=0; i<matches.length; i++) {
                locals[parserResult.itemName] = matches[i];
                scope.matches.push({
                  label: parserResult.viewMapper(scope, locals),
                  model: matches[i]
                });
              }

              scope.query = inputValue;
              //position pop-up with matches - we need to re-calculate its position each time we are opening a window
              //with matches as a pop-up might be absolute-positioned and position of an input might have changed on a page
              //due to other elements being rendered
              scope.position = appendToBody ? $position.offset(element) : $position.position(element);
              scope.position.top = scope.position.top + element.prop('offsetHeight');

            } else {
              resetMatches();
            }
            isLoadingSetter(originalScope, false);
          }
        }, function(){
          resetMatches();
          isLoadingSetter(originalScope, false);
        });
      };

      resetMatches();

      //we need to propagate user's query so we can higlight matches
      scope.query = undefined;

      //Declare the timeout promise var outside the function scope so that stacked calls can be cancelled later 
      var timeoutPromise;

      //plug into $parsers pipeline to open a autocomplete on view changes initiated from DOM
      //$parsers kick-in on all the changes coming from the view as well as manually triggered by $setViewValue

      function action(inputValue) {

        if(clickLoad && !inputValue)
          inputValue = __nofilter;

        hasFocus = true;

        if (angular.equals(inputValue, __nofilter) || (inputValue && inputValue.length >= minSearch)) {
          if (waitTime > 0) {
            if (timeoutPromise) {
              $timeout.cancel(timeoutPromise);//cancel previous timeout
            }
            timeoutPromise = $timeout(function () {
              getMatchesAsync(inputValue);
            }, waitTime);
          } else {
            getMatchesAsync(inputValue);
          }
        } else {
          isLoadingSetter(originalScope, false);
          resetMatches();
        }

        if(clickLoad && inputValue == __nofilter)
          return undefined;

        if (isEditable) {
          return inputValue;
        } else {
          if (!inputValue) {
            // Reset in case user had typed something previously.
            modelCtrl.$setValidity('editable', true);
            return inputValue;
          } else {
            modelCtrl.$setValidity('editable', false);
            return undefined;
          }
        }
      }

      modelCtrl.$parsers.unshift(action);

      modelCtrl.$formatters.push(function (modelValue) {

        var candidateViewValue, emptyViewValue;
        var locals = {};

        if (inputFormatter) {

          locals['$model'] = modelValue;
          return inputFormatter(originalScope, locals);

        } else {

          //it might happen that we don't have enough info to properly render input value
          //we need to check for this situation and simply return model value if we can't apply custom formatting
          locals[parserResult.itemName] = modelValue;
          candidateViewValue = parserResult.viewMapper(originalScope, locals);
          locals[parserResult.itemName] = undefined;
          emptyViewValue = parserResult.viewMapper(originalScope, locals);

          return candidateViewValue!== emptyViewValue ? candidateViewValue : modelValue;
        }
      });

      scope.select = function (activeIdx) {
        //called from within the $digest() cycle
        var locals = {};
        var model, item;

        locals[parserResult.itemName] = item = scope.matches[activeIdx].model;
        model = parserResult.modelMapper(originalScope, locals);

        $setModelValue(originalScope, model);
        modelCtrl.$setValidity('editable', true);

        onSelectCallback(originalScope, {
          $item: item,
          $model: model,
          $label: parserResult.viewMapper(originalScope, locals)
        });

        resetMatches();
      
        //return focus to the input element if a mach was selected via a mouse click event
        element[0].focus();
      };

      //点击加载下拉选择列表
      if(clickLoad){
         element.bind('click', function (evt){
            scope.$apply(function(){
              hasFocus = true;
              if(element[0].value)
                 getMatchesAsync(element[0].value);
              else
                 getMatchesAsync(__nofilter);
            });
         });
      }
      
      //bind keyboard events: arrows up(38) / down(40), enter(13) and tab(9), esc(27)
      element.bind('keydown', function (evt) {

        //autocomplete is open and an "interesting" key was pressed
        if (scope.matches.length === 0 || HOT_KEYS.indexOf(evt.which) === -1) {
          return;
        }

        evt.preventDefault();

        if (evt.which === 40) {
          scope.activeIdx = (scope.activeIdx + 1) % scope.matches.length;
          scope.$digest();

        } else if (evt.which === 38) {
          scope.activeIdx = (scope.activeIdx ? scope.activeIdx : scope.matches.length) - 1;
          scope.$digest();

        } else if (evt.which === 13 || evt.which === 9) {
          scope.$apply(function () {
            scope.select(scope.activeIdx);
          });

        } else if (evt.which === 27) {
	        evt.stopPropagation();
	        resetMatches();
	        scope.$digest();
        }
      });

      element.bind('blur', function (evt) {
        hasFocus = false;
    });


      // Keep reference to click handler to unbind it.
      var dismissClickHandler = function (evt) {
        if (element[0] !== evt.target) {
          resetMatches();
          scope.$digest();
        }
      };

      $document.bind('click', dismissClickHandler);

      originalScope.$on('$destroy', function(){
        $document.unbind('click', dismissClickHandler);
      });

      var $popup = $compile(popUpEl)(scope);
      if ( appendToBody ) {
        $document.find('body').append($popup);
      } else {
        element.after($popup);
      }
    }
  };

}])

  .directive('autocompletePopup', function () {
    return {
      restrict:'EA',
      scope:{
        matches:'=',
        query:'=',
        active:'=',
        position:'=',
        select:'&',
        popupClass:'@'
      },
      replace:true,
      templateUrl:'template/autocomplete/autocomplete-popup.html',
      link:function (scope, element, attrs) {

        scope.templateUrl = attrs.templateUrl;

        scope.isOpen = function () {
          return scope.matches.length > 0;
        };

        scope.isActive = function (matchIdx) {
          return scope.active == matchIdx;
        };

        scope.selectActive = function (matchIdx) {
          scope.active = matchIdx;
        };

        scope.selectMatch = function (activeIdx) {
          scope.select({'activeIdx':activeIdx});
        };
      }
    };
  })

  .directive('autocompleteMatch', ['$http', '$templateCache', '$compile', '$parse', function ($http, $templateCache, $compile, $parse) {
    return {
      restrict:'EA',
      scope:{
        index:'=',
        match:'=',
        query:'='
      },
      link:function (scope, element, attrs) {
        var tplUrl = $parse(attrs.templateUrl)(scope.$parent) || 'template/autocomplete/autocomplete-match.html';
        
        $http.get(tplUrl, {cache: $templateCache}).success(function(tplContent){
           element.replaceWith($compile(tplContent.trim())(scope));
        });
      }
    };
  }])

  .filter('autocompleteHighlight',['$$__nofilter', function(__nofilter) {

    function escapeRegexp(queryToEscape) {
      return queryToEscape.replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1");
    }

    return function(matchItem, query) {
      if(angular.equals(query, __nofilter))
        return matchItem;
      else
        return query ? matchItem.replace(new RegExp(escapeRegexp(query), 'gi'), '<strong style="*color:#FFADC8">$&</strong>') : matchItem;
    };
  }])

  /**
 * A set of utility methods that can be use to retrieve position of DOM elements.
 * It is meant to be used where we need to absolute-position DOM elements in
 * relation to other, existing elements (this is the case for tooltips, popovers,
 * typeahead suggestions etc.).
 */
  .factory('$position', ['$document', '$window', function ($document, $window) {

    function getStyle(el, cssprop) {
      if (el.currentStyle) { //IE
        return el.currentStyle[cssprop];
      } else if ($window.getComputedStyle) {
        return $window.getComputedStyle(el)[cssprop];
      }
      // finally try and get inline style
      return el.style[cssprop];
    }

    /**
     * Checks if a given element is statically positioned
     * @param element - raw DOM element
     */
    function isStaticPositioned(element) {
      return (getStyle(element, 'position') || 'static' ) === 'static';
    }

    /**
     * returns the closest, non-statically positioned parentOffset of a given element
     * @param element
     */
    var parentOffsetEl = function (element) {
      var docDomEl = $document[0];
      var offsetParent = element.offsetParent || docDomEl;
      while (offsetParent && offsetParent !== docDomEl && isStaticPositioned(offsetParent) ) {
        offsetParent = offsetParent.offsetParent;
      }
      return offsetParent || docDomEl;
    };

    return {
      /**
       * Provides read-only equivalent of jQuery's position function:
       * http://api.jquery.com/position/
       */
      position: function (element) {
        var elBCR = this.offset(element);
        var offsetParentBCR = { top: 0, left: 0 };
        var offsetParentEl = parentOffsetEl(element[0]);
        if (offsetParentEl != $document[0]) {
          offsetParentBCR = this.offset(angular.element(offsetParentEl));
          offsetParentBCR.top += offsetParentEl.clientTop - offsetParentEl.scrollTop;
          offsetParentBCR.left += offsetParentEl.clientLeft - offsetParentEl.scrollLeft;
        }

        var boundingClientRect = element[0].getBoundingClientRect();
        return {
          width: boundingClientRect.width || element.prop('offsetWidth'),
          height: boundingClientRect.height || element.prop('offsetHeight'),
          top: elBCR.top - offsetParentBCR.top,
          left: elBCR.left - offsetParentBCR.left
        };
      },

      /**
       * Provides read-only equivalent of jQuery's offset function:
       * http://api.jquery.com/offset/
       */
      offset: function (element) {
        var boundingClientRect = element[0].getBoundingClientRect();
        return {
          width: boundingClientRect.width || element.prop('offsetWidth'),
          height: boundingClientRect.height || element.prop('offsetHeight'),
          top: boundingClientRect.top + ($window.pageYOffset || $document[0].documentElement.scrollTop),
          left: boundingClientRect.left + ($window.pageXOffset || $document[0].documentElement.scrollLeft)
        };
      },

      /**
       * Provides coordinates for the targetEl in relation to hostEl
       */
      positionElements: function (hostEl, targetEl, positionStr, appendToBody) {

        var positionStrParts = positionStr.split('-');
        var pos0 = positionStrParts[0], pos1 = positionStrParts[1] || 'center';

        var hostElPos,
          targetElWidth,
          targetElHeight,
          targetElPos;

        hostElPos = appendToBody ? this.offset(hostEl) : this.position(hostEl);

        targetElWidth = targetEl.prop('offsetWidth');
        targetElHeight = targetEl.prop('offsetHeight');

        var shiftWidth = {
          center: function () {
            return hostElPos.left + hostElPos.width / 2 - targetElWidth / 2;
          },
          left: function () {
            return hostElPos.left;
          },
          right: function () {
            return hostElPos.left + hostElPos.width;
          }
        };

        var shiftHeight = {
          center: function () {
            return hostElPos.top + hostElPos.height / 2 - targetElHeight / 2;
          },
          top: function () {
            return hostElPos.top;
          },
          bottom: function () {
            return hostElPos.top + hostElPos.height;
          }
        };

        switch (pos0) {
          case 'right':
            targetElPos = {
              top: shiftHeight[pos1](),
              left: shiftWidth[pos0]()
            };
            break;
          case 'left':
            targetElPos = {
              top: shiftHeight[pos1](),
              left: hostElPos.left - targetElWidth
            };
            break;
          case 'bottom':
            targetElPos = {
              top: shiftHeight[pos0](),
              left: shiftWidth[pos1]()
            };
            break;
          default:
            targetElPos = {
              top: hostElPos.top - targetElHeight,
              left: shiftWidth[pos1]()
            };
            break;
        }

        return targetElPos;
      }
    };
  }])

  .filter('pinyin',function() {
    return function(input, format) {
    	if(input){
    		switch(format){
          //first_letter 首字母
    			case "f":
    				return pinyin(input, {style: pinyin.STYLE_FIRST_LETTER});
          //all_for_search
    			case "a":
    				return pinyin.buildSearchString(input);
    		}
    	}else{
    		return "";
    	}
    };
  });

        