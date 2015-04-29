'use strict'

/***
@author Vikram Somu
@date 1/25/2015

PIPELINED COURSE CONNECTOR
A piplined system to connect my MongoDB database
to oscar.gatech's course catalog in order to sync 
our systems.

This class could be refactored out into two seperate classes:
One queue processing class and another HTML parsing class.
*/

var https = require('https'),
    cheerio = require('cheerio'),
    monk = require('monk'),
    FCallQueueProcessor = require('./FCallQueueProcessor.js'),
    poller_interval = null;

function CatalogConnector(connection_url, term_mgr, unprobedt_delay) {
	var db = monk(connection_url);
	this.term_mgr = term_mgr;
	this.course_info = db.get('course_info');
	this.term_courses = db.get('term_courses');
	// this.start_crn = 10000;
	// this.end_crn = 99999;
	this.start_crn = 10000;
	this.end_crn = 90000;
	this.start_unprobed_term_poller(unprobedt_delay);
	this.qprocessor = new FCallQueueProcessor(this.crn_path_valid, this);
};

// Start looking for new terms that have been uploaded to OSCAR
CatalogConnector.prototype.start_unprobed_term_poller = function(delay) {
	var _this = this;

	poller_interval = setInterval(function() {
		_this.poll_unprobed_terms(function(unprobed) {
			unprobed.forEach(function(e, i) {
				//Limit 1 term at a time for probing
				//Process only the first found term.
				if(i == 0) {
					_this.probe_term_for_crns(e.code);
				}
			});
		});
	}, delay);
};

CatalogConnector.prototype.stop_unprobed_term_poller = function() {
	if(poller_interval) {
		clearInterval(poller_interval);
	}
};

/*
THIS IS WHERE CONSUMER (CatalogConnector) MEETS PRODUCER (TermManager)
*/
CatalogConnector.prototype.poll_unprobed_terms = function(cb) {
	// Process one term at a time, wait till the q is empty to proceed.
	if(this.qprocessor.empty()) {
		this.term_mgr.get_unprobed_terms(cb);
	}
};


// Start looking for unrecorded CRNs from OSCAR catalog for a given term
CatalogConnector.prototype.probe_term_for_crns = function(term_code) {
	var pathComponents= [
		'/pls/bprod/bwckschd.p_disp_detail_sched?term_in=',
		'4digityear',
		'2digitmonth',
		'&crn_in=',
		'crn_val'
	],
  	term_period = this.term_mgr.decompose_term_code(term_code),
  	start_crn = this.start_crn,
  	stop_crn = this.end_crn,
  	// stop_crn = 99999,
  	_this = this;

	for(var i=start_crn; i<=stop_crn; i++) {
		pathComponents[1] = term_period.year;
		pathComponents[2] = term_period.month;
		pathComponents[4] = i;
		var path_to_probe = pathComponents.join('');

		/* For whatever reason, transition_cb only properly retains it's
		value when the dequeuer pops it off the queue if I declare it this way. 
		Declaring it with function transition_cb() notation gives me an 
		undefined error */
		var transition_cb = function(is_valid, $, term_code, path) {			
			if(is_valid) {
				_this.check_catalog_entry($, term_code, path);
			}
		};

		// Ideally, we would have checked the term_code + crn combo here
		// and only add it the qprocessor if the termcod + crn combo is not 
		// already in term_courses.

		this.qprocessor.fcall_q.push([i, term_code, path_to_probe, transition_cb]);
		this.qprocessor.alert_q_to_poll();
	};

	_this.term_mgr.set_probed(term_code, true);
};

// Probe PHASE 1, if this term has not been recorded, hit OSCAR 
// and check to see if the CRN is valid... if so we check to see if it
// a valid entry, and then we start parsing it (Phase 2).
CatalogConnector.prototype.crn_path_valid = function(crn, term, path, cb) {
  var _this = this;

  //Doesn't even use this when called by FCallQueueProcessor
  if(arguments.length == 1) {
  	var crn = arguments[0][0],
  		term = arguments[0][1],
  		path = arguments[0][2],
  		cb = arguments[0][3]
  }

  // console.log("PRE CHECK DUPE: ", crn, term);

  // Only transition to .check_catalog_entry if CRN, TERMCODE combination
  // Are not found in the term_courses collection.
  this.term_courses.find({term: term, crn: crn})
	.on('success', function (docs) {
	  	if(docs.length == 0) {
	  		_this.gt_https_req(path, function($){
	  			// console.log('err len', $('.errortext').length)
		  		// console.log("CRN TESTED: ", crn, ' ', term)

		      if(!$('.errortext').length) {
		      	// console.log('VALID DOCs: ', docs, term, crn);
		      	// console.log('VALID CRN: ', crn, ' ', term);
		      	cb(true, $, term, path);
		      }
	  		});
	  	}
	})
	.on('error', function(err){
		console.log(err);
	});

};


//Probe PHASE 2. Check to see if it has a catalog entry.
"'Detailed Class Information' page"
CatalogConnector.prototype.check_catalog_entry = function($, term, path) {
	var _this = this;

	// TRACKING show paths that belong to VALID CRNS
	// console.log(path);

	$('a').each(function() {
		if(_this.link_to_text(this) == 'View Catalog Entry') {
			_this.parse_catalog_entry(term, this.attribs.href);			
		}
	});
};

"'Detailed Class Information' page"
// Probe the catalog entry and scrape out information.
CatalogConnector.prototype.parse_catalog_entry = function(term, path) {
	var _this = this;

	this.gt_https_req(path, function($) {
		var class_title_e = $('.nttitle a'),
			class_title_txt = _this.link_to_text(class_title_e['0']),
			course_info_comps = null;

		if($('.ntdefault').html()) {
			course_info_comps = $('.ntdefault').html().split('<br>');			
		}

		if(class_title_txt) {
			var title_comps = class_title_txt.split('-'),
				tmp = title_comps[0].trim(),
				tmp = tmp.split(' '),
				subj = tmp[0],
				course_num = tmp[1],
				course_title = title_comps[1].trim();

			parse_html(course_info_comps, subj, course_num, course_title);
			check_sched_path(course_info_comps, subj, course_num);
		}

	});

	// PARSE HTML SECTION
	function parse_html(course_info_comps, subj, course_num, course_title) {
		var course_info_obj = {
			subj: subj,
			num: course_num,
			title: course_title
		};

		/*
		Add a course to the course_info collection if it is not already present.
		*/

		_this.course_info.find(course_info_obj)
		.on('success', function(docs) {
			//If the course isn't present in the catalog, parse and add it.
			if(docs.length == 0) {
				parse_sequentially();
				parse_filtering();
			}

		});

		function parse_sequentially() {
			var step_idx = 0;
			var translate_step = {
				0 : 'desc',
				1 : 'credit_hrs',
				2 : 'lect_hrs',
			};

			for(var i in course_info_comps) {
				var test = course_info_comps[i].trim();

				if(test.length != 0 && step_idx < 3) {
					var translation = translate_step[step_idx];
					course_info_obj[translation] = test;
					step_idx++;
				}
			}

			course_info_obj.credit_hrs = course_info_obj.credit_hrs.split(' ')[0];
			course_info_obj.lect_hrs = course_info_obj.lect_hrs.split(' ')[0];
		}

		function parse_filtering() {
			var grade_basis = course_info_comps.filter(function(e) {
				return e.match(/span/);
			});

			if(grade_basis.length) {
				grade_basis = grade_basis[0].split('>').pop();
				course_info_obj.grade_basis = grade_basis.trim();
			}

			var dept = course_info_comps.filter(function(e) {
				return e.match(/Depart|Dept/i);
			});

			if(dept.length) {
				course_info_obj.dept = dept[0].trim();
			}

			_this.save_course_info(course_info_obj);
		}

	};

	// CHECK SCHED PATH SECTION

	function check_sched_path(course_info_comps, subj, course_num) {

		if(course_info_comps) {
			//Find the Schedule listings page path to probe.
			var sched_listing_href = course_info_comps.filter(function(e) {
				return e.match(/href/);
			});

			if(sched_listing_href.length) {
				var sched_txt = sched_listing_href[0].trim(),
						start_link_idx = sched_txt.indexOf('"'),
						end_link_idx = sched_txt.indexOf('"', start_link_idx + 1);
				
				if(start_link_idx != -1 && end_link_idx != -1) {
					var sched_path = sched_txt.slice(start_link_idx+1, end_link_idx),
							sched_path = sched_path.replace(/&amp;/g, '&');

					_this.parse_schedule_listing(term, sched_path);
				}
			}
		}

	};

};

"'Detailed Class Information' page"
//Probe and parse the schedule listing page
CatalogConnector.prototype.parse_schedule_listing = function(term, path) {
	var _this = this;
	// console.log(path);

	// console.log('INSIDE PARSE SCHEDULE LISTING');
	// console.log(term, path);

	_this.gt_https_req(path, function($) {
		$('.datadisplaytable[summary="This layout table is used to present the sections found"] > tr')
		.each(function(i, row){
			var section_header = $(row).children('th')['0'];

			if(section_header) {
				var header_link = $(section_header).children('a')['0'],
						header_txt = $(header_link).text(),
						header_comps = header_txt.split(' - ');

				eval_sect_title(header_comps, function(sect_obj) {
					if(sect_obj) {
						var next_row = $(row).next(),
								data_cell = $(next_row).children('td')['0'],
								meeting_rows = $(data_cell).find('tr').slice(1),
								upper_table = $(next_row).html().split('<br>');

						parse_meeting_table(meeting_rows, sect_obj, $, function(sect_obj) {
							parse_upper_table(upper_table, sect_obj, function(sect_obj) {
								// console.log("SAVE TERM CALLED");
								// console.log('saving: ', sect_obj.crn);
								_this.save_term_course(sect_obj);
							});
						});
					};

				});
			};

		});
	});

	function eval_sect_title(title_comps, cb) {
		if(title_comps.length > 3) {
			//handle case where name of course has a hyphen in it
			if(title_comps.length == 5) {
				// transform non-standard form title (length 5) into standard form title (length 4)
				title_comps = [
					title_comps[0] + '-' + title_comps[1],
					title_comps[2],
					title_comps[3],
					title_comps[4]
				]
			}

			var sect_obj = check_obj;

			sect_obj.title = title_comps[0].trim();

			var tmp = title_comps[2].trim().split(' ');
			sect_obj.subj = tmp[0];
			sect_obj.num = tmp[1];
			sect_obj.sect_id = title_comps[3].trim();

			cb(sect_obj);
		}
	};

	function parse_meeting_table(meeting_rows, sect_obj, $, cb) {
		sect_obj.meetings = [];

		//Parse the meeting time tables
		meeting_rows.each(function(meeting_idx, meeting_row) {
			sect_obj.meetings.push({});
			$(meeting_row).find('td').each(function(cell_idx,data_cell) {
				var cur_meeting = sect_obj.meetings[meeting_idx],
						cell_contents = $(data_cell).text();

				if(cell_idx == 1) {
					var time_comps = cell_contents.split('-');
					if (time_comps.length == 2) {
						cur_meeting.start_time = time_comps[0].trim();
						cur_meeting.end_time = time_comps[1].trim();												
					}else {
						cur_meeting.start_time = time_comps[0].trim();
						cur_meeting.end_time = time_comps[0].trim();																							
					}
				}else if(cell_idx == 2) {
					cur_meeting.days = cell_contents.trim();
				}else if(cell_idx == 3) {
					cur_meeting.location = cell_contents.trim();											
				}else if(cell_idx == 4) {
					var date_comps = cell_contents.split('-');
					cur_meeting.start_date = date_comps[0].trim();
					cur_meeting.end_date = date_comps[1].trim();
				}else if(cell_idx == 5) {
					cur_meeting.type = cell_contents.trim();
				}else if(cell_idx == 6) {
					cur_meeting.instructor = cell_contents.trim();
				}

			});
		});

		cb(sect_obj);
	};

	//Parse the shit above the meeting time tables
	function parse_upper_table(upper_table, sect_obj, cb) {
		var i = 0;
		while(i < upper_table.length) {
			var test = upper_table[i].trim();
			if(test.length > 0) {
				sect_obj.warnings = test;
				break;
			}
		}

		var reg_dates = upper_table.filter(function(e) {
			return e.match(/Registration Dates/i);
		});

		if(reg_dates.length) {
			var reg_dates = reg_dates[0].split(':').pop().trim(),
					reg_date_comps = reg_dates.split(' to ');
			sect_obj.reg_start_date = new Date(reg_date_comps[0]);
			sect_obj.reg_end_date = new Date(reg_date_comps[1]);
		}

		var levels = upper_table.filter(function(e) {
			return e.match(/Levels:/i);
		});

		if(levels.length) {
			var level_str = levels[0].split('>').pop().trim();
			sect_obj.levels = level_str.split(', ');
		}

		var grade_basis = upper_table.filter(function(e) {
			return e.match(/Grade Basis/i);
		});

		if(grade_basis.length) {
			sect_obj.grade_basis = grade_basis[0].split('>').pop().trim();
		}

		cb(sect_obj)
	};


};


CatalogConnector.prototype.save_course_info = function(course_info_obj) {
	this.course_info.insert(course_info_obj);
};

CatalogConnector.prototype.save_term_course = function(sect_obj) {
	this.term_courses.insert(sect_obj);
};

CatalogConnector.prototype.link_to_text = function(link_e) {
	if(link_e && link_e.children && link_e.children.length > 0) {
		if(link_e.children[0] && link_e.children[0].data) {
			return link_e.children[0].data.trim();
		}
	}	

	return ""
};

CatalogConnector.prototype.gt_https_req = function(path, cb) {
  var options = {
    hostname: 'oscar.gatech.edu',
    port: 443,
    path: path,
    method: 'GET',
    rejectUnauthorized: 'false'
  };

  var req = https.request(options, function(res) {
    var body = [];
    res.setEncoding('utf8');

    res
    .on('data', function(chunk) {
      body.push(chunk);
    })
    .on('end', function() {
    	var $ = cheerio.load(body.join(''));
    	cb($);
    });
  });

  req.end();
  req.on('error', function(e) {
     console.log("Error: " + e.message); 
     console.log( e.stack );
     req.end();
  });
};

module.exports = CatalogConnector;
