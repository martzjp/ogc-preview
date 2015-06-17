/* --------------------------------
 Developed by Jonathan Meyer
 Applied Information Sciences
 7/8/2014
 ---------------------------------*/

angular.module('opApp.query')
    .service('opWebFeatureService',
    function ($q, $http, opConfig) {
        'use strict';

        // Using WFS 1.1.0 for the very specific reason, that 2.0.0 always runs full table scan to get feature counts.
        // With the size of the data we are dealing with, this is not acceptable.
        // We are also being forced to use XML as JSON as of GeoServer 2.4 always includes the feature count.
        this.WFS_VERSION = opConfig.server.wfsVersion;
        this.URL = opConfig.server.url + '/wfs';
        this.AJAX_URL = opConfig.server.ajaxUrl + '/wfs';

        /**
         * Determine all fields and their associated types for a given layer name and workspace.
         *
         * @param name
         * @param workspace
         * @returns {Promise} array of JSON objects containing name and type of fields
         */
        this.extractFieldsAndTypes = function (name, workspace) {
            var deferred = $q.defer();
            var error;

            this.describeFeatureType(name, workspace).then(
                function (result) {
                    if (result !== null) {
                        var xmlDoc = $.parseXML(result.data);

                        var nodes = xmlDoc.getElementsByTagNameNS('*', 'complexType');

                        // Verify the complexType node exists and contains an attribute
                        if (nodes && nodes.length > 0 && nodes.item(0).hasAttributes()) {
                            var typeNode = nodes.item(0);
                            // Verify that response is referencing typeName we are interested in
                            if (typeNode.attributes['name'].textContent.replace('Type', '') === name) {
                                var fields = [];

                                var elementNodes = typeNode.childNodes[1].childNodes[1].childNodes[1].childNodes;

                                for (var i = 0; i < elementNodes.length; i++) {
                                    var node = elementNodes.item(i);
                                    if (node.nodeType === 1 && node.nodeName === 'xsd:element') {
                                        var field = {};
                                        field.name = node.attributes['name'].textContent;
                                        field.type = node.attributes['type'].textContent;
                                        fields.push(field);
                                    }
                                }

                                deferred.resolve(fields);
                            }
                        }
                        else {
                            error = 'Unable to parse DescribeFeatureType response: ' + result.data;
                            console.log(error);
                            deferred.reject(error);
                        }
                    }
                    else {
                        error = 'Null response received from DescribeFeatureType';
                        console.log(error);
                        deferred.reject(error);
                    }
                },
                function (reason) {
                    error = 'Failure in DescribeFeatureType request for start/stop field names: ' + reason;
                    console.log(error);
                    deferred.reject(error);
                });

            return deferred.promise;
        };

        /**
         * Retrieve the DescribeFeatureType response for specified name and workspace
         *
          * @param name
         * @param workspace
         * @returns {*}
         */
        this.describeFeatureType = function (name, workspace) {
            var deferred = $q.defer();

            var typeName = workspace + ':' + name;
            var params = { version: this.WFS_VERSION, request: 'DescribeFeatureType', typeName: typeName };

            $http.get(this.AJAX_URL, {params: params }).then(function (result) {
                console.log('Successfully retrieved DescribeFeatureType result.');
                deferred.resolve(result);
            }, function (reason) {
                // error
                var error ='Error retrieving DescribeFeatureType result: ' + reason;
                console.log(error);
                deferred.reject(error);
            });

            return deferred.promise;
        };

        /**
         * Retrieve the GetFeature response for the specified name and workspace.  Basic request can be augmented with
         * any desired parameters set in params
         * @param name
         * @param workspace
         * @param params JSON object of KVP to include in GetFeature request
         * @returns {*}
         */
        this.getFeature = function (name, workspace, params) {
            var deferred = $q.defer();

            var typeName = workspace + ':' + name;
            var serviceParams = angular.extend({ version: this.WFS_VERSION, request: 'GetFeature', typeName: typeName }, params);

            $http.get(this.AJAX_URL, {params: serviceParams, cache:true }).then(
                function (result) {
                    console.log('Successfully retrieved GetFeature result.');
                    deferred.resolve(result);
                },
                function (reason) {
                    // error
                    console.log('Error retrieving GetFeature result');
                    deferred.reject(reason);
                });

            return deferred.promise;
        };

        /**
         * Attempt to retrieve features as GML and convert into GeoJSON resolved into promise
         *
         * @param name layer name
         * @param workspace layer workspace
         * @param fields layer fields, must be passed so xml can be converted into 'Feature' properties
         * @param params JSON KVP of WFS parameters to be applied to the request
         * @returns {Deferred.promise|*}
         */
        this.getFeaturesAsJson = function(name, workspace, fields, params) {
            var deferred = $q.defer();

            // Use to filter out geometry fields from results
            var allowedFields = [];
            for (var i=0; i < fields.list.length; i++) {
                if (fields.list[i].type.indexOf(opConfig.geomFieldNamespace) === -1) {
                    allowedFields.push(fields.list[i].name);
                }
            }

            // Tack on the desired format as this is our preferred for parsing.
            params = angular.extend(params, { outputFormat: opConfig.server.wfsOutputFormat });

            this.getFeature(name, workspace, params).then(
                function (result) {
                    var xmlDoc = $.parseXML(result.data);

                    var json = {type:'FeatureCollection', features:[]};

                    var nodes = xmlDoc.getElementsByTagNameNS('*', 'featureMembers');
                    if (nodes.length === 1) {
                        for (var i=0; i < nodes[0].childNodes.length; i++) {
                            var feature =
                            {
                                type : 'Feature',
                                id : nodes[0].childNodes[i].attributes['gml:id'].textContent,
                                properties : {}
                            };

                            for (var j=0; j < nodes[0].childNodes[i].childNodes.length; j++)
                            {
                                var node = nodes[0].childNodes[i].childNodes[j];
                                if (node.nodeType === 1 && allowedFields.indexOf(node.localName) > -1) {
                                    feature.properties[node.localName] = node.textContent;
                                }
                            }
                            json.features.push(feature);
                        }

                        deferred.resolve(json);
                    }
                    else {
                        console.log(params);
                        var error = 'Unable to find any features in ' + workspace + ':' + name +  ' with params: ' + JSON.stringify(params);
                        console.log(error);
                        deferred.resolve(json);
                    }
                },
                function (reason) {
                    deferred.reject(reason);
                }
            );

            return deferred.promise;
        };

        /**
         * Perform a GetFeature request on specified field in ASC order to determine min time
         * @param name
         * @param workspace
         * @param field
         * @returns {*}
         */
        this.findTimeMin = function (name, workspace, field) {
            return this.findTimeMinMax(name, workspace, field, 'A');
        };

        /**
         * Perform a GetFeature request on specified field in DESC order to determine max time
         * @param name
         * @param workspace
         * @param field
         * @returns {*}
         */
        this.findTimeMax = function (name, workspace, field) {
            return this.findTimeMinMax(name, workspace, field, 'D');
        };

        /**
         * Identifies whether any data is present for a layer given optional temporal/spatial filters.
         *
         * @param name layer name
         * @param workspace layer workspace
         * @param fields layer's fields objects - this must be an array of objects with name and type properties
         * @param filter optional filter in CQL format
         * @returns {Deferred.promise|*}
         */
        this.isDataPresent = function (name, workspace, fields, filter) {
            var deferred = $q.defer();

            this.getFilteredJsonFeatures(name, workspace, fields, filter, {maxFeatures: 1}).then(
                function (result) {
                    if (result.features && result.features.length === 1) {
                        deferred.resolve(true);
                    }

                    deferred.resolve(false);
                },
                function (reason) {
                    console.log('Error attempting to determine if data is present: ' + reason);
                    deferred.resolve(false);
                }
            );

            return deferred.promise;
        };

        /**
         *
         * @param name
         * @param workspace
         * @param fields
         * @param filters
         * @param extendedParams
         * @returns {Deferred.promise|*}
         */
        this.getFilteredJsonFeatures = function (name, workspace, fields,
                                                 filters, extendedParams) {
            var params = filters;
            if (angular.isDefined(extendedParams) && extendedParams !== null) {
                params = angular.extend(params, extendedParams);
            }

            return this.getFeaturesAsJson(name, workspace, fields, params);
        };

        /**
         * Perform a GetFeature request on specified field in appropriate order with a single result to determine
         * min or max value of data.
         *
         * @param name
         * @param workspace
         * @param field
         * @param direction 'A' or 'D' to indicate order of request
         * @returns {*}
         */
        this.findTimeMinMax = function (name, workspace, field, direction) {
            var deferred = $q.defer();

            var params = { maxFeatures: 1, sortby: field + ' ' + direction.toUpperCase()};
            this.getFeature(name, workspace, params).then(
                function (result) {
                    var xmlDoc = $.parseXML(result.data);

                    var nodes = xmlDoc.getElementsByTagNameNS('*', field);
                    if (nodes.length > 0) {
                        var node = null;
                        for (var i=0; i < nodes.length; i++) {
                            // Verify we have the namespaced field
                            if (nodes[i].prefix === workspace) {
                                node = nodes[i].textContent;
                            }
                        }

                        if (node !== null) {
                            deferred.resolve(node);
                        }
                        else {
                            deferred.reject('Unable to find expected field in GetFeature XML response.');
                        }
                    }
                    else {
                        var error = 'Unable to find value of expected field: ' + field;
                        error += ' This is likely a result of layer having no records.';
                        console.log(error);
                        deferred.reject(error);
                    }
                },
                function (reason) {
                    console.log('Unable to identify a min/max time for field ' + field);
                    deferred.reject(reason);
                }
            );

            return deferred.promise;
        };
    });
